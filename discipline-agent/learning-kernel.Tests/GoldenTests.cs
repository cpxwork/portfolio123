using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Xunit;

namespace LearningKernel.Tests;

/// <summary>
/// 进程级金样测试（M-K 步骤③）：期望值由 gen-golden.mjs 用独立 JS 重实现的公式生成，
/// 绝不取自 C# 内核输出。每个用例一个 dotnet 进程（协议：单命令单进程）。
/// 容差 1e-6（FormulaConstants.GoldenTolerance）。
/// </summary>
public class GoldenTests
{
    private static readonly string[] GoldenFiles =
        { "review", "interval", "score", "transition", "scanDebts", "optimize" };

    public static string GoldenDir =>
        Path.Combine(AppContext.BaseDirectory, "golden");

    public static IEnumerable<object[]> Cases()
    {
        foreach (var file in GoldenFiles)
        {
            var path = Path.Combine(GoldenDir, file + ".json");
            Assert.True(File.Exists(path), "金样缺失: " + path);
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            foreach (var c in doc.RootElement.EnumerateArray())
                yield return new object[] { file, c.Clone() };
        }
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Golden(string file, JsonElement caseEl)
    {
        var name = caseEl.GetProperty("name").GetString()!;
        var args = caseEl.GetProperty("args");
        var expect = caseEl.GetProperty("expect");

        var payload = JsonSerializer.Serialize(new { cmd = file, args });
        var (exit, stdout, stderr) = KernelRunner.Run(payload);
        Assert.True(exit == 0, $"{file}/{name}: 内核非零退出（崩溃） stderr={stderr}");
        using var doc = JsonDocument.Parse(stdout);
        var root = doc.RootElement;
        Assert.True(root.ValueKind == JsonValueKind.Object &&
                    root.TryGetProperty("ok", out var okEl) && okEl.GetBoolean(),
            $"{file}/{name}: 响应异常 stdout={stdout[..Math.Min(stdout.Length, 400)]} stderr={stderr[..Math.Min(stderr.Length, 200)]}");

        var data = root.GetProperty("data");
        if (file == "optimize") AssertOptimize(name, expect, data);
        else DeepAssert(expect, data, $"{file}/{name}");
    }

    /// <summary>optimize：exact 用例精确比；invariants 用例断言结构性质（迭代优化器数值期望不可独立复算，见 NOTES）</summary>
    private static void AssertOptimize(string name, JsonElement expect, JsonElement data)
    {
        var kind = expect.GetProperty("kind").GetString();
        var spec = expect.GetProperty("data");
        if (kind == "exact")
        {
            DeepAssert(spec, data, "optimize/" + name);
            return;
        }
        // invariants：examples 精确；iterations 达标；weights 在可行盒内；improved 语义
        Assert.Equal(spec.GetProperty("examples").GetInt32(), data.GetProperty("examples").GetInt32());
        Assert.True(data.GetProperty("iterations").GetInt32() >= spec.GetProperty("minIterations").GetInt32(),
            "optimize/" + name + ": 迭代次数未达下限");
        var w = data.GetProperty("weights").EnumerateArray().Select(x => x.GetDouble()).ToArray();
        double[] lower = { 0.001, 0.001, 0.001, 0.001, 1.0, 0.001, 0.001, 0.001, 0, 0, 0.001, 0.001, 0.001, 0.001, 0, 0, 1.0, 0, 0, 0, 0.1 };
        double[] upper = { 100, 100, 100, 100, 10, 4, 4, 0.75, 4.5, 0.8, 3.5, 5, 0.25, 0.9, 4, 1, 6, 2, 2, 0.8, 0.8 };
        Assert.Equal(21, w.Length);
        for (var i = 0; i < 21; i++)
            Assert.True(w[i] >= lower[i] - 1e-9 && w[i] <= upper[i] + 1e-9,
                $"optimize/{name}: w[{i}]={w[i]} 越界 [{lower[i]},{upper[i]}]");
        var improved = data.GetProperty("improved").GetBoolean();
        if (improved)
            Assert.True(data.GetProperty("finalLoss").GetDouble() < data.GetProperty("initialLoss").GetDouble(),
                "optimize/" + name + ": improved=true 但 loss 未降");
    }

    /// <summary>深度比较：数值容差 1e-6；对象逐属性；数组逐元素；其余按 JSON 文本精确比</summary>
    private static void DeepAssert(JsonElement expect, JsonElement actual, string path)
    {
        switch (expect.ValueKind)
        {
            case JsonValueKind.Number:
                Assert.True(actual.ValueKind == JsonValueKind.Number, path + " 期望数字，实际 " + actual.ValueKind);
                var e = expect.GetDouble();
                var a = actual.GetDouble();
                Assert.True(Math.Abs(a - e) <= 1e-6, $"{path}: 期望 {e} 实际 {a}（差 {Math.Abs(a - e)}）");
                break;
            case JsonValueKind.Object:
                Assert.True(actual.ValueKind == JsonValueKind.Object, path + " 期望对象");
                foreach (var p in expect.EnumerateObject())
                    DeepAssert(p.Value, actual.GetProperty(p.Name), path + "." + p.Name);
                break;
            case JsonValueKind.Array:
                Assert.True(actual.ValueKind == JsonValueKind.Array, path + " 期望数组");
                var ev = expect.EnumerateArray().ToArray();
                var av = actual.EnumerateArray().ToArray();
                Assert.True(ev.Length == av.Length, $"{path}: 数组长度 {av.Length} != {ev.Length}");
                for (var i = 0; i < ev.Length; i++) DeepAssert(ev[i], av[i], $"{path}[{i}]");
                break;
            default:
                // 语义比较（不能比 GetRawText：内核 stdout 用 \uXXXX 转义，金样文件是原文中文）
                switch (expect.ValueKind)
                {
                    case JsonValueKind.String:
                        Assert.True(actual.ValueKind == JsonValueKind.String, path + " 期望字符串，实际 " + actual.ValueKind);
                        Assert.Equal(expect.GetString(), actual.GetString());
                        break;
                    default:
                        Assert.True(expect.ValueKind == actual.ValueKind,
                            $"{path}: 期望 {expect.ValueKind} 实际 {actual.ValueKind}");
                        break;
                }
                break;
        }
    }
}

/// <summary>合同测试：错误/边界输入必须返回完整 {ok:false,error} 且 exit 0（协议：只有真崩溃才非 0）</summary>
public class KernelContractTests
{
    public static IEnumerable<object[]> ErrorCases()
    {
        var path = Path.Combine(GoldenTests.GoldenDir, "errors.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
            yield return new object[] { c.Clone() };
    }

    [Theory]
    [MemberData(nameof(ErrorCases))]
    public void ErrorContract(JsonElement caseEl)
    {
        var name = caseEl.GetProperty("name").GetString()!;
        var payload = caseEl.GetProperty("payload").GetString()!;
        var expectError = caseEl.GetProperty("expectError").GetString()!;

        var (exit, stdout, _) = KernelRunner.Run(payload);
        using var doc = JsonDocument.Parse(stdout); // 响应必须完整可解析
        var root = doc.RootElement;
        Assert.False(root.GetProperty("ok").GetBoolean(), name + " 应拒绝");
        var err = root.GetProperty("error").GetString() ?? "";
        Assert.True(err.Contains(expectError, StringComparison.OrdinalIgnoreCase),
            $"{name}: error「{err}」未包含「{expectError}」");
        Assert.Equal(0, exit); // ok:false 也 exit 0（协议）
    }
}

/// <summary>内核进程调用辅助：stdin 写一个请求，收齐 stdout/stderr/exit</summary>
internal static class KernelRunner
{
    public static string KernelDll()
    {
        // 从 Tests/bin/... 向上找包含 learning-kernel/ 的祖先（discipline-agent），不依赖固定层数
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "learning-kernel")))
            dir = dir.Parent;
        Assert.True(dir != null, "未找到含 learning-kernel/ 的仓库根（从 " + AppContext.BaseDirectory + " 向上）");
        var dll = Path.Combine(dir.FullName, "learning-kernel", "bin", "Debug", "net10.0", "learning-kernel.dll");
        Assert.True(File.Exists(dll), "kernel dll 未找到（先 dotnet build learning-kernel）：" + dll);
        return dll;
    }

    public static (int Exit, string Stdout, string Stderr) Run(string payload)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{KernelDll()}\"")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
            StandardInputEncoding = new UTF8Encoding(false), // 无 BOM（Encoding.UTF8 会写 BOM，内核虽能剥但源头干净）
        };
        using var p = Process.Start(psi)!;
        var outTask = p.StandardOutput.ReadToEndAsync();
        var errTask = p.StandardError.ReadToEndAsync();
        p.StandardInput.Write(payload);
        p.StandardInput.Close();
        var stdout = outTask.GetAwaiter().GetResult();
        var stderr = errTask.GetAwaiter().GetResult();
        p.WaitForExit(30000);
        return (p.ExitCode, stdout, stderr);
    }
}
