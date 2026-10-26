# 验证记录

## 嗨皮瓜

2026-10-26 在现有本地工作副本运行：

```bash
node --test --test-isolation=none haipigua/tests/*.test.cjs
```

输出：142 tests / 142 pass / 0 fail / 0 skipped。检查包含模拟响应、本机 HTTP 及轻量 DOM 合同；不代表线上用户成功率。当前本地工作副本还含其他开发修改，本记录只描述该副本的实际运行，不将其结果绑定为远端 main 的完整验收。

## Product Evaluation Lab

```bash
cd product-eval-lab
python -m unittest -v
python lab.py
python build_dashboard.py
```

2026-10-26：23 项单元测试通过；8 条脚本轨迹全部符合各自的成功或拒绝预期。12 条查询的排序与聚合指标见 `results/report.json`。

浏览器检查：切换到 `bm25_current` 后 Q01 的首项为当前退款文档；查看 A05 得到工具不在白名单内的拒绝原因；切换 `allocation_problem` 显示 `allocation_mismatch`。

## 作品集

10 页 PDF，包含产品案例、实习职责、团队公开成果、独立评测实践、模拟数据分析及研究竞赛。团队公开数字有来源，模型合同检查和模拟分析分列。
