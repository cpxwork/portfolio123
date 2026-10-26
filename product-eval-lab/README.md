# Product Evaluation Lab

把 AI 产品验证拆成三个可检查的环节：证据能否找到、工具是否按约束执行、产品指标能否支持决策。

仅依赖 Python 3.10+ 标准库。默认实验不联网、不需要密钥。

```bash
cd product-eval-lab
python -m unittest -v
python lab.py
python build_dashboard.py
```

直接打开 `index.html` 阅读交互报告；它使用内嵌的实际运行结果，可筛选检索版本、查看 Agent 轨迹、对照增长实验。修改代码或样例后重新生成报告，避免把旧结果当作新结果。

## 01 / ReAct 机制与可控执行

依据 Yao et al. 的 [ReAct（ICLR 2023）](https://arxiv.org/abs/2210.03629)，实现“选择动作 - 执行工具 - 读取观察 - 再选择动作”的编排机制。工具仅开放 `search`、`read`、`finish`，记录逐步 observation，限制调用次数，要求最终摘录引用本轮读取过的文档。

八条固定轨迹覆盖：正常交付、未读引用、无依据陈述、预算超限、文档诱导的越权工具、旧版本文档、非法参数、缺少最终交付。

默认轨迹使用脚本决策，验证执行器合同，不测量模型推理能力。`live.py` 提供显式开启的模型接口；通过 `LAB_API_KEY`、`LAB_API_ENDPOINT`、`LAB_MODEL` 配置，运行时另加 `--allow-paid-api`。当前提交的结果来自离线固定轨迹。最终答案是证据原文摘录，引用通过不等于一般生成文本的事实正确。

## 02 / 检索评测与版本约束

12 条人工查询、12 份虚构产品文档，比较词项覆盖、BM25、BM25 + 当前版本过滤三种配置；逐条记录相关文档、返回排序、Recall@3、MRR@3 和 nDCG@3。

旧退款规则作为版本干扰项保留。过滤由显式版本元数据驱动，适用于检验知识有效期对检索质量的影响。当前没有把全语料向量训练、DPR/BART 或原始问答基准纳入实验，因此不称为 NeurIPS 2020 RAG 的完整复现。

## 03 / A/B 分析与诊断

账号哈希稳定分组；分别报告支付转化差、双侧两比例近似检验、Newcombe-Wilson 95% 差值区间和退款率；检查 50/50 分流异常。低计数返回 `insufficient_counts`，分流异常返回 `allocation_mismatch`。

严格漏斗先去重，再约束用户、会话、订单、事件顺序及七日窗口。案例使用合成汇总数据，固定分析时点；退款护栏需独立评估，不用单个显著性结果自动决定上线。

## 结果与复核

[机器可读结果](results/report.json) · [固定输入](fixtures.json) · [核心实现](lab.py) · [边界测试](test_lab.py) · [产品决策说明](DECISIONS.md)

所有查询和相关性标签均为本项目编写，指标反映这组小样本上的表现，不代表真实客户数据、模型准确率或外部盲测。报告保留逐条结果及错误，固定输入文件的 SHA-256 用于核对版本。

## 论文与实现范围

Yao et al., *ReAct: Synergizing Reasoning and Acting in Language Models*, ICLR 2023. [论文](https://arxiv.org/abs/2210.03629) / [作者实现](https://github.com/ysymyth/ReAct)。本项目独立编写工具编排与测试，没有复制作者代码，也未复跑 HotpotQA、FEVER、ALFWorld 或 WebShop。

Lewis et al., *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*, NeurIPS 2020. [论文](https://arxiv.org/abs/2005.11401)。本项目借鉴检索证据与生成分工的问题意识，仅实现词项检索对照，不复现原文的联合训练架构或论文指标。
