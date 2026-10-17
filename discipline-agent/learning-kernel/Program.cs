using System.Text;
using System.Text.Json;
using AstralPath.Core.Algorithms;
using AstralPath.Core.Formula;
using AstralPath.Core.Planner;
using ReciteHelper.Core.Scheduling;

namespace LearningKernel;

/// <summary>
/// learning-kernel —— 学习子系统 C# 内核（M-K1）
///
/// 进程边界协议（契约：A任务提示词 M-K1 §3.0）：
///   stdin 读一个 JSON 请求 {"cmd":"...","args":{...}}，
///   stdout 写 {"ok":true,"data":{...}} / {"ok":false,"error":"..."} / {"ok":true,"needLLM":{...}} 后退出。
///   响应完整可解析（即使 ok:false 也 exit 0）；内核真正崩溃（未捕获异常逃逸）非 0，
///   由 Node 侧契约测试覆盖"内核崩溃"用例。
///
/// 红线（M-K 任务书 §7）：
///   调度/评分/销账/到期的最终数字只由这里（确定性代码）产出；
///   cleared 只由 SaleStateMachine 写，Node 只读；
///   LLM 需求以 needLLM 挂起响应返回、由 Node 的 llm-client 代调，C# 不直连 API。
///
/// 上游源码直接引用（零移植误差，基线见 NOTES.md 来源对照表）：
///   AstralPath.Core   = ClassTechStar/-Knowledge-Debt-Astral-Path main@45e6cab
///   ReciteHelper.Core = ArabidopsisDev/ReciteHelper primary@3943f38
/// </summary>
internal static class Program
{
    private static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        try { Console.InputEncoding = Encoding.UTF8; } catch { /* 管道输入无控制台代码页时可省 */ }
        string input;
        try { input = Console.In.ReadToEnd().TrimStart('\uFEFF'); } // 调用方可能带 UTF-8 BOM（红线：协议健壮）
        catch (Exception e) { return WriteError("stdin 读取失败: " + e.Message); }
        if (string.IsNullOrWhiteSpace(input)) return WriteError("空请求");

        JsonDocument doc;
        try { doc = JsonDocument.Parse(input); }
        catch (Exception e) { return WriteError("JSON 解析失败: " + e.Message); }

        using (doc)
        using (var empty = JsonDocument.Parse("{}"))
        {
            var root = doc.RootElement;
            var cmd = root.TryGetProperty("cmd", out var c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
            var args = root.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object ? a : empty.RootElement;

            object data;
            try
            {
                data = cmd switch
                {
                    "review" => CmdReview(args),
                    "interval" => CmdInterval(args),
                    "score" => CmdScore(args),
                    "scanDebts" => CmdScanDebts(args),
                    "transition" => CmdTransition(args),
                    "planDay" => CmdPlanDay(args),
                    "graph" => CmdGraph(args),
                    "optimize" => CmdOptimize(args),
                    "extractPoints" => CmdExtractPoints(args),
                    "genQuestions" => CmdGenQuestions(args),
                    "analyzeWrong" => CmdAnalyzeWrong(args),
                    "buildGraph" => throw new NotImplementedException("buildGraph（GraphBuild 队列管线）在 ⑦ 步实现"),
                    _ => throw new ArgumentException("未知 cmd: " + (cmd ?? "(无)"))
                };
            }
            catch (Exception e)
            {
                return WriteError(String(e.Message));
            }

            if (data is NeedLlmPending p)
                return WriteJson(new { ok = true, needLLM = new { role = p.Role, step = "await_result", input = p.Input } });
            return WriteJson(new { ok = true, data });
        }
    }

    private sealed record NeedLlmPending(string Role, object Input);

    private static string String(string? s) => (s ?? "kernel 异常").Replace('\n', ' ');

    // ───────────────────────── 参数辅助 ─────────────────────────

    private static double D(JsonElement e, string name, double def)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : def;

    private static int I(JsonElement e, string name, int def)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : def;

    private static string? S(JsonElement e, string name)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool B(JsonElement e, string name, bool def)
        => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.True || v.ValueKind == JsonValueKind.False) ? v.GetBoolean() : def;

    private static SchedulerParameters ParamsOf(JsonElement args)
    {
        if (args.TryGetProperty("w", out var w) && w.ValueKind == JsonValueKind.Array && w.GetArrayLength() == SchedulerParameters.Count)
        {
            var list = new List<double>(SchedulerParameters.Count);
            foreach (var x in w.EnumerateArray()) list.Add(x.GetDouble());
            return SchedulerParameters.Clamped(list);
        }
        return SchedulerParameters.Default;
    }

    private static int WriteJson(object payload)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(payload));
        return 0;
    }

    private static int WriteError(string message)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(new { ok = false, error = message }));
        return 0;
    }

    // ───────────────────────── 确定性 cmd ─────────────────────────

    /// <summary>review：FSRS-6 状态推进（新知识点传 state=null 走 InitialState）</summary>
    private static object CmdReview(JsonElement args)
    {
        var grade = (ReviewGrade)I(args, "grade", 3);
        if ((int)grade is < 1 or > 4) throw new ArgumentException("grade 必须是 1..4（Again/Hard/Good/Easy）");
        var p = ParamsOf(args);
        var elapsed = Math.Max(D(args, "elapsedDays", 0), 0);
        var retention = D(args, "retention", 0.9);
        if (retention <= 0 || retention >= 1) throw new ArgumentException("retention 必须严格在 0..1 之间");

        MemoryState before, after;
        if (args.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.Object)
        {
            before = new MemoryState(D(st, "stability", 0), D(st, "difficulty", 0));
            after = FsrsAlgorithm.NextState(before, elapsed, grade, p);
        }
        else
        {
            after = FsrsAlgorithm.InitialState(grade, p);
            before = after;
        }

        var r = FsrsAlgorithm.Retrievability(before.Stability, elapsed, p);
        var intervalDays = FsrsAlgorithm.IntervalForRetention(after.Stability, retention, p);
        return new
        {
            stability = after.Stability,
            difficulty = after.Difficulty,
            retrievability = r,
            intervalDays,
            intervalForRetention = retention
        };
    }

    /// <summary>interval：给定稳定性反解到期间隔（天）</summary>
    private static object CmdInterval(JsonElement args)
    {
        var stability = Math.Max(D(args, "stability", 0), 0);
        var retention = D(args, "retention", 0.9);
        if (retention <= 0 || retention >= 1) throw new ArgumentException("retention 必须严格在 0..1 之间");
        var p = ParamsOf(args);
        var intervalDays = FsrsAlgorithm.IntervalForRetention(stability, retention, p);
        return new { intervalDays, stability, retention };
    }

    /// <summary>
    /// score：知识点掌握分（上游 MasteryCalculator.ComputeScore，score-v2）。
    /// 与任务书 §3.2 散文公式的差异以上游为准：Jeffreys 先验 (s+0.5)/(s+f+1)、
    /// prereqSupport=(1-λ)·mean+λ·min（λ=0.65）、无先修时 support 中性 0.5 且不封顶。
    /// </summary>
    private static object CmdScore(JsonElement args)
    {
        var attempts = Math.Max(I(args, "attempts", 0), 0);
        var successes = Math.Max(I(args, "successes", 0), 0);
        var conf = Math.Clamp(D(args, "confidence", 0), 0, FormulaConstants.ConfScale);
        var age = Math.Max(D(args, "lastAgeDays", 0), 0);
        var streak = Math.Max(I(args, "streak", 0), 0);

        var prereq = new List<double>();
        bool degraded = !(args.TryGetProperty("prereqScores", out var ps) && ps.ValueKind == JsonValueKind.Array && ps.GetArrayLength() > 0);
        if (!degraded)
            foreach (var x in ps.EnumerateArray()) prereq.Add(x.GetDouble());

        var input = new MasteryInput(attempts, successes, conf, age, streak, prereq);
        var score = MasteryCalculator.ComputeScore(input);

        // 明细分解（与 ComputeScore 同口径，供上游展示层用）
        var emp = MasteryCalculator.Empirical(attempts, successes);
        var confNorm = Math.Clamp(conf / FormulaConstants.ConfScale, 0, 1);
        var know = 0.85 * emp + 0.15 * confNorm;
        var ret = MasteryCalculator.Retention(age, streak, attempts);
        var pre = MasteryCalculator.PrereqSupport(prereq);
        var ceil = MasteryCalculator.PrereqCeiling(prereq);
        var note = degraded ? "无图谱：prereqSupport 中性 0.5，无先修封顶（ceiling=1.0）" : "";

        return new
        {
            score, know, emp, confidence = conf,
            stability = MasteryCalculator.Stability(streak, attempts),
            retention = ret, prereqSupport = pre, prereqCeiling = ceil,
            degraded, degradedNote = note
        };
    }

    /// <summary>scanDebts：知识债批量扫描（impact-v2：平滑门限×最弱缺口×级联×体量）</summary>
    private static object CmdScanDebts(JsonElement args)
    {
        if (!(args.TryGetProperty("edges", out var edges) && edges.ValueKind == JsonValueKind.Array))
            throw new ArgumentException("scanDebts 需要 edges 数组");
        var debts = new List<object>();
        var hitCount = 0;
        foreach (var e in edges.EnumerateArray())
        {
            var edgeType = S(e, "edgeType") == "transferGap" ? EdgeType.TransferGap : EdgeType.Prerequisite;
            var input = new DebtInput(
                D(e, "scoreFrom", 0), D(e, "scoreTo", 0), Math.Max(D(e, "weight", 1.0), 0),
                edgeType, I(e, "freq", 0), I(e, "downstreamCount", 0));
            var impact = DebtScanner.ComputeImpact(input);
            var hit = DebtScanner.IsHit(input);
            if (hit) hitCount++;
            debts.Add(new
            {
                scoreFrom = input.ScoreFrom, scoreTo = input.ScoreTo, weight = input.Weight,
                edgeType = edgeType == EdgeType.TransferGap ? "transferGap" : "prerequisite",
                freq = input.Freq, downstreamCount = input.DownstreamCount,
                impact, hit
            });
        }
        return new { debts, hitCount, count = debts.Count };
    }

    /// <summary>
    /// transition：销账状态机（红线：cleared 只由这里写）。
    /// mode=transition（默认）推进状态；mode=probe 按历史查询是否可销账。
    /// </summary>
    private static object CmdTransition(JsonElement args)
    {
        var mode = S(args, "mode") ?? "transition";
        if (mode == "probe")
        {
            var history = new List<SaleProbe>();
            if (args.TryGetProperty("history", out var hs) && hs.ValueKind == JsonValueKind.Array)
                foreach (var h in hs.EnumerateArray())
                    history.Add(new SaleProbe(Math.Clamp(D(h, "acc", 0), 0, 1), I(h, "conf", 0)));
            var res = SaleCompat.IsSaleable(history);
            return new { mode = "probe", saleable = res.Saleable, streak = res.Streak, need = res.Need };
        }

        if (!(args.TryGetProperty("attempt", out var at) && at.ValueKind == JsonValueKind.Object))
            throw new ArgumentException("transition 需要 attempt {correct, accuracy, selfConf}");
        var attempt = new SaleAttempt(B(at, "correct", false), Math.Clamp(D(at, "accuracy", 0), 0, 1), I(at, "selfConf", 0));

        SaleState state;
        if (args.TryGetProperty("state", out var st) && st.ValueKind == JsonValueKind.Object)
        {
            var status = (S(st, "status") ?? "open") switch
            {
                "repairing" => SaleStatus.Repairing,
                "cleared" => SaleStatus.Cleared,
                _ => SaleStatus.Open
            };
            state = new SaleState(status, Math.Max(I(st, "streak", 0), 0), Math.Max(I(st, "attempts", 0), 0), I(st, "weightedScorePct", 0));
        }
        else
        {
            state = SaleStateMachine.Create();
        }

        var next = SaleStateMachine.Transition(state, attempt);
        return new
        {
            status = next.Status.ToString(),
            streak = next.Streak,
            attempts = next.Attempts,
            weightedScorePct = next.WeightedScorePct,
            cleared = next.Status == SaleStatus.Cleared,
            attemptWeighted = SaleStateMachine.Weighted(attempt),
            attemptMeetsBar = SaleStateMachine.MeetsBar(attempt)
        };
    }

    /// <summary>planDay：0/2/6 间隔 + 影响优先 + 每日容量；可选 checkDays 走 K1-K5 校验</summary>
    private static object CmdPlanDay(JsonElement args)
    {
        if (!(args.TryGetProperty("debts", out var debtsArr) && debtsArr.ValueKind == JsonValueKind.Array))
            throw new ArgumentException("planDay 需要 debts 数组");
        var goals = new List<PlannerBuilder.DebtGoal>();
        foreach (var d in debtsArr.EnumerateArray())
            goals.Add(new PlannerBuilder.DebtGoal(
                S(d, "fromKp") ?? "", S(d, "toKp") ?? "", D(d, "impact", 0),
                S(d, "fromName"), S(d, "toName")));

        var horizon = I(args, "horizonDays", 14);
        var budget = I(args, "dayBudget", 40);
        var items = PlannerBuilder.Build(goals, horizon, budget);
        var itemObjs = items.Select(x => new
        {
            id = x.Id, kpId = x.KpId, kpName = x.KpName, type = x.Type,
            difficulty = x.Difficulty, estMin = x.EstMin, why = x.Why,
            debtRef = x.DebtRef, fromKpName = x.FromKpName, status = x.Status
        }).ToList();

        object? check = null;
        if (args.TryGetProperty("checkDays", out var cd) && cd.ValueKind == JsonValueKind.Array)
        {
            var days = new List<PlanDayInput>();
            foreach (var day in cd.EnumerateArray())
            {
                var dayItems = new List<PlanItemInput>();
                if (day.TryGetProperty("items", out var di) && di.ValueKind == JsonValueKind.Array)
                    foreach (var it in di.EnumerateArray())
                        dayItems.Add(new PlanItemInput(
                            S(it, "id") ?? "", S(it, "kpId") ?? "", S(it, "kpName") ?? "",
                            S(it, "type") ?? "review", I(it, "difficulty", 2), I(it, "estMin", 10),
                            S(it, "why") ?? "", Array.Empty<string>(), S(it, "fromKpName"), S(it, "status") ?? "pending"));
                days.Add(new PlanDayInput(I(day, "day", 0), dayItems));
            }
            var topDebts = goals.Select(g => (g.FromKp, g.ToKp)).ToList();
            var res = PlannerConstraintChecker.Check(days, budget, topDebts);
            check = new
            {
                constraintsChecked = res.ConstraintsChecked,
                violationCount = res.Violations.Count,
                violations = res.Violations.Select(v => new { code = v.Code, day = v.Day, message = v.Message }).ToList()
            };
        }

        return new { items = itemObjs, count = itemObjs.Count, check };
    }

    /// <summary>graph：图谱查询（action=order 拓扑序+环校验 / action=prereqs 直接先修）</summary>
    private static object CmdGraph(JsonElement args)
    {
        var action = S(args, "action") ?? "order";
        var nodes = new List<string>();
        if (args.TryGetProperty("nodes", out var ns) && ns.ValueKind == JsonValueKind.Array)
            foreach (var n in ns.EnumerateArray())
                nodes.Add(n.GetString() ?? "");
        var edges = new List<(string From, string To)>();
        if (args.TryGetProperty("edges", out var es) && es.ValueKind == JsonValueKind.Array)
            foreach (var e in es.EnumerateArray())
                edges.Add((S(e, "from") ?? "", S(e, "to") ?? ""));

        if (action == "order")
        {
            // 有环时 TopologicalOrder 抛出（含环节点清单）→ Main 转 ok:false
            var order = GraphTopology.TopologicalOrder(nodes, edges);
            return new { action, order, count = order.Count };
        }
        if (action == "prereqs")
        {
            var kpId = S(args, "kpId") ?? throw new ArgumentException("graph.action=prereqs 需要 kpId");
            var prereqs = GraphTopology.DirectPrereqs(kpId, edges);
            return new { action, kpId, prereqs, count = prereqs.Count };
        }
        throw new ArgumentException("graph.action 目前只支持 order|prereqs（layers/bottlenecks/downstreamMass 后续补）");
    }

    /// <summary>optimize：个人 FSRS-6 参数拟合（Adam 全批 + 合法域投影，确定性）</summary>
    private static object CmdOptimize(JsonElement args)
    {
        var seqs = new List<ReviewSequence>();
        if (args.TryGetProperty("reviews", out var rs) && rs.ValueKind == JsonValueKind.Array)
            foreach (var seq in rs.EnumerateArray())
            {
                var revs = new List<(int ElapsedDays, ReviewGrade Grade)>();
                if (seq.ValueKind == JsonValueKind.Array)
                    foreach (var r in seq.EnumerateArray())
                        revs.Add((Math.Max(I(r, "elapsedDays", 0), 0), (ReviewGrade)I(r, "grade", 3)));
                seqs.Add(new ReviewSequence(revs));
            }

        SchedulerParameters? start = null;
        bool usedDefault = true;
        if (args.TryGetProperty("startW", out var sw) && sw.ValueKind == JsonValueKind.Array && sw.GetArrayLength() == SchedulerParameters.Count)
        {
            var list = new List<double>(SchedulerParameters.Count);
            foreach (var x in sw.EnumerateArray()) list.Add(x.GetDouble());
            start = SchedulerParameters.Clamped(list);
            usedDefault = false;
        }

        var fit = new FsrsOptimizer().Fit(seqs, start);
        return new
        {
            weights = fit.Parameters.Weights,
            initialLoss = fit.InitialLoss, finalLoss = fit.FinalLoss,
            examples = fit.Examples, iterations = fit.Iterations,
            improved = fit.Improved, usedDefault
        };
    }

    // ───────────────── needLLM 挂起（红线 8：C# 不直连 API） ─────────────────

    private static object CmdExtractPoints(JsonElement args)
    {
        if (args.TryGetProperty("llmResult", out _))
            throw new NotImplementedException("extractPoints 的 LLM 结果后处理在 ⑥ 步实现");
        var text = S(args, "text");
        if (string.IsNullOrWhiteSpace(text)) throw new ArgumentException("extractPoints 需要 text（资料文本）");
        return new NeedLlmPending("extractor", new { text, pipeline = "extractPoints" });
    }

    private static object CmdGenQuestions(JsonElement args)
    {
        if (args.TryGetProperty("llmResult", out _))
            throw new NotImplementedException("genQuestions 的 LLM 结果后处理在 ⑧ 步实现");
        var text = S(args, "text") ?? S(args, "material");
        var points = args.TryGetProperty("points", out var pts) && pts.ValueKind == JsonValueKind.Array
            ? pts.EnumerateArray().Select(x => x.GetString() ?? "").Where(x => x.Length > 0).ToList()
            : new List<string>();
        if (string.IsNullOrWhiteSpace(text) && points.Count == 0)
            throw new ArgumentException("genQuestions 需要 text（原文）或 points（知识点列表）");
        return new NeedLlmPending("quizzer", new { text = text ?? "", points, pipeline = "genQuestions" });
    }

    private static object CmdAnalyzeWrong(JsonElement args)
    {
        if (args.TryGetProperty("llmResult", out _))
            throw new NotImplementedException("analyzeWrong 的 LLM 结果后处理在 ⑧ 步实现");
        var question = S(args, "question");
        var answer = S(args, "answer");
        if (string.IsNullOrWhiteSpace(question)) throw new ArgumentException("analyzeWrong 需要 question（题目）");
        return new NeedLlmPending("diagnostician", new { question, answer = answer ?? "", pipeline = "analyzeWrong" });
    }
}
