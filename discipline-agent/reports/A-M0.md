# A-M0 里程碑报告：指令通道 + 隔离区/还原

> 按《交接提示词.md》第 9 节格式。里程碑实际完成于 2026-10-16；本报告于 2026-10-17 按当前代码现状补写核对。

## 1. 新增/修改的文件

| 文件 | 一句话说明 |
|---|---|
| `instructions.js` | 指令 JSON schema 校验（6.1 全字段，不合法抛错并附 `errors` 数组）+ 指令总线：`issue`（幂等去重）/ `ack` / `complete` / `revoke(taskId)`，每次流转追加 JSONL 审计行 |
| `manifest.js` | 可逆账本：原路径↔新路径、instructionId、createdAt；先写账再动手、每完成一条立即回写，崩溃也可还原 |
| `executor.js` | 本地执行器：`quarantine_files` 移入 `workRoot/.quarantine/<manifestId>/`、`shuffle_desktop` 顶层普通文件随机改名（保留扩展名、跳过目录与点开头文件）、`restore` 幂等还原、`restoreAll` 时间倒序全量还原；workRoot 拒绝系统目录/盘符根/用户主目录 |
| `crypto-vault.js` | 隔离区加密封装：一把 manifest 一把密钥，密钥与密文分目录；认证失败不落盘、解密失败不留明文 |
| `test-util.js` | 测试辅助：`fs.mkdtempSync(os.tmpdir())` 临时目录、断言集、sha256、套件汇总退出码 |
| `demo-m0.js` | A-M0 闭环演示（隔离→还原→sha256 逐字节核对） |
| `instructions.test.js` / `manifest.test.js` / `executor.test.js` / `crypto-vault.test.js` | 四套测试 |

## 2. 测试怎么跑、结果

```
node run-tests.js        # 全量（或单套直跑：node executor.test.js）
instructions.test.js: 13/13 通过
manifest.test.js: 8/8 通过
executor.test.js: 23/23 通过
crypto-vault.test.js: 10/10 通过
```

验收 6 条对应覆盖：
1. 移动 3 个测试文件 → `restore` 后 sha256 逐字节一致 ✅
2. manifest 含完整 原路径↔新路径、instructionId、createdAt ✅
3. 重复 `restore` 幂等、不重复还原 ✅
4. 原位被占 → 记 `conflict`，原文件绝不被覆盖 ✅
5. `C:\`、`C:\Windows`、用户主目录作 workRoot 均被拒 ✅
6. 审计日志含 issue→ack→complete/revoke 全链路 ✅

## 3. 与第 6 节契约有无偏差

- **6.1 指令契约无偏差**：action 枚举、级别映射、payload 规格（`quarantine_files`→`targets`、`shuffle_desktop`→`targetDir`）、校验项全部按 6.1 实现。
- `crypto-vault.js` 不在 6.3 模块清单——实现中为隔离区新增的加密配套（清单是最低集，非封闭集），已记 NOTES。
- `notify`/`popup_countdown`/`spawn_bugs` 按规格为前端动作，executor 原样返回"非本地动作"。

## 4. 记入 NOTES.md 的疑点

- 审计日志必须放 `<workRoot>/.discipline/audit/`：executor 把账本/审计目录列为内部资产，shuffle 永不触碰，真实部署同样适用（NOTES #16）。
- 测试 runner 语义：`createSuite` 分 beforeAll/afterAll 与 before/after（NOTES #18）；同步 run 不接受 Promise 用例，async 走 `runAsync()`（NOTES #17）。

## 自查（进入下一里程碑前）

- [x] 上一级测试全绿（4 套 54 用例）
- [x] 契约未擅改（新增 `crypto-vault.js` 已显式记录）
- [x] 没有新增隐私/合规章节
- [x] 没有碰 `portfolio123` 之外的文件
