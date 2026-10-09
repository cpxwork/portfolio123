"""AI辅助创建的SQL学习作品。所有用户、行为、订单均为确定种子的模拟数据。

核心数据生成、SQLite和CSV只需Python标准库；PNG图另需Pillow。
运行：python generate_and_analyze.py
可改变SEED进行练习，但默认产物和报告使用固定SEED=20261008。
"""
from __future__ import annotations

import base64
import csv
import hashlib
import html
import json
import math
from pathlib import Path
import random
import re
import sqlite3
from datetime import date, datetime, time, timedelta

ROOT = Path(__file__).resolve().parent
SEED = 20261008
START = date(2026, 9, 1)
END = date(2026, 10, 7)
CUTOFF = datetime(2026, 10, 8)
DAYS = (END - START).days + 1
USER_COUNT = 1200
CHANNELS = ["organic", "paid_search", "campus", "referral"]
CHANNEL_NAMES = {"organic": "自然流量", "paid_search": "模拟付费搜索", "campus": "模拟校园渠道", "referral": "模拟推荐渠道"}
BASE_ACTIVE = {"organic": .52, "paid_search": .42, "campus": .56, "referral": .65}
FMT = "%Y-%m-%d %H:%M:%S"


def stamp(value: datetime) -> str:
    return value.strftime(FMT)


def export_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def generate():
    rng = random.Random(SEED)
    users, events, orders = [], [], []
    uuid_counter, order_counter = 0, 0

    def event(uid: int, name: str, at: datetime):
        nonlocal uuid_counter
        uuid_counter += 1
        uid_key = f"EV{uuid_counter:07d}"
        base = dict(event_uuid=uid_key, user_id=uid, event_name=name,
                    event_at=stamp(at), ingest_at=stamp(at + timedelta(seconds=15)))
        events.append(base)
        # 约4%的事件发生重传；event_uuid保持不变，不能按raw_id计业务行为。
        if rng.random() < .04:
            events.append({**base, "ingest_at": stamp(at + timedelta(seconds=75))})

    def order(uid: int, at: datetime):
        nonlocal order_counter
        order_counter += 1
        oid = f"OD{order_counter:06d}"
        amount = rng.choice([3990, 6990, 9990])
        base = dict(order_id=oid, user_id=uid, created_at=stamp(at),
                    amount_cents=amount, refund_cents=0)
        orders.append({**base, "updated_at": stamp(at), "status": "pending"})
        draw = rng.random()
        status = "failed" if draw < .08 else "pending" if draw < .14 else "paid"
        final_at = at + timedelta(minutes=30)
        final = {**base, "updated_at": stamp(final_at), "status": status}
        orders.append(final)
        if rng.random() < .05:
            orders.append(final.copy())
        if status == "paid":
            refund_draw = rng.random()
            if refund_draw < .17:
                # 晚于观察截止的退款快照仍写入raw数据，分析必须按as-of排除。
                refund = amount if refund_draw < .09 else amount // 2
                orders.append({**final, "updated_at": stamp(final_at + timedelta(days=rng.randint(1, 4))),
                               "refund_cents": refund})

    for uid in range(1, USER_COUNT + 1):
        channel = rng.choices(CHANNELS, [.35, .25, .22, .18])[0]
        signup_day = START + timedelta(days=rng.randint(0, DAYS - 1))
        signup = datetime.combine(signup_day, time(8, rng.randint(0, 59)))
        users.append(dict(user_id=uid, signup_at=stamp(signup), channel=channel,
                          is_test=int(uid % 50 == 0)))
        event(uid, "signup", signup)
        if rng.random() > .88:
            continue
        for age in range((END - signup_day).days + 1):
            # 渠道和用户年龄影响生成概率，故渠道差异是生成规则，不能作商业因果结论。
            prob = .9 if age == 0 else BASE_ACTIVE[channel] * math.exp(-age / 18) + .04
            if rng.random() > prob:
                continue
            today = signup_day + timedelta(days=age)
            at = datetime.combine(today, time(rng.randint(9, 19), rng.randint(0, 40)))
            event(uid, "launch", at)
            if rng.random() < .91:
                event(uid, "feature_view", at + timedelta(minutes=1))
                if rng.random() < .73:
                    event(uid, "core_action", at + timedelta(minutes=2))
                    if rng.random() < .30:
                        event(uid, "paywall_view", at + timedelta(minutes=3))
                        if rng.random() < .18:
                            order(uid, at + timedelta(minutes=4))
            # 同一天重复启动，日活仍只算一名用户。
            if rng.random() < .20:
                event(uid, "launch", at + timedelta(minutes=5))

    # 8条越界时间事件、6条不存在用户的事件：显式的数据质量练习。
    for n in range(8):
        at = datetime(2026, 8, 31, 12, n)
        event(1, "launch", at)
    for n in range(6):
        event(9000 + n, "launch", datetime(2026, 9, 15, 12, n))
    for raw_id, row in enumerate(events, 1):
        row["raw_id"] = raw_id
    for raw_id, row in enumerate(orders, 1):
        row["raw_id"] = raw_id
    return users, events, orders


def build_database(users, events, orders):
    con = sqlite3.connect(ROOT / "simulation.sqlite")
    con.row_factory = sqlite3.Row
    con.executescript("""
    DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS events_raw;
    DROP TABLE IF EXISTS orders_raw; DROP TABLE IF EXISTS calendar;
    CREATE TABLE users (
      user_id INTEGER PRIMARY KEY, signup_at TEXT NOT NULL,
      channel TEXT NOT NULL, is_test INTEGER NOT NULL CHECK(is_test IN (0,1))
    );
    CREATE TABLE events_raw (
      raw_id INTEGER PRIMARY KEY, event_uuid TEXT NOT NULL, user_id INTEGER NOT NULL,
      event_name TEXT NOT NULL, event_at TEXT NOT NULL, ingest_at TEXT NOT NULL
    );
    CREATE TABLE orders_raw (
      raw_id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','paid','failed')),
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      refund_cents INTEGER NOT NULL CHECK(refund_cents >= 0 AND refund_cents <= amount_cents)
    );
    CREATE TABLE calendar(day TEXT PRIMARY KEY);
    CREATE INDEX events_user_day ON events_raw(user_id, event_at);
    CREATE INDEX orders_key_time ON orders_raw(order_id, updated_at);
    """)
    for table, records, fields in [
        ("users", users, ["user_id", "signup_at", "channel", "is_test"]),
        ("events_raw", events, ["raw_id", "event_uuid", "user_id", "event_name", "event_at", "ingest_at"]),
        ("orders_raw", orders, ["raw_id", "order_id", "user_id", "created_at", "updated_at", "status", "amount_cents", "refund_cents"]),
    ]:
        con.executemany(f"INSERT INTO {table} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})",
                        [[row[field] for field in fields] for row in records])
        export_csv(ROOT / "data" / f"{table}.csv", fields, records)
    con.executemany("INSERT INTO calendar(day) VALUES (?)", [((START + timedelta(days=d)).isoformat(),) for d in range(DAYS)])
    con.commit()
    return con


def execute_queries(con):
    sql = (ROOT / "analysis.sql").read_text(encoding="utf-8")
    setup = sql.split("-- SETUP BEGIN", 1)[1].split("-- SETUP END", 1)[0]
    con.executescript(setup)
    results = {}
    for name, query in re.findall(r"-- RESULT: ([a-z0-9_]+)\n(.*?)(?=-- RESULT:|\Z)", sql, flags=re.S):
        cursor = con.execute(query.strip())
        fields = [field[0] for field in cursor.description]
        rows = [dict(row) for row in cursor.fetchall()]
        export_csv(ROOT / "results" / f"{name}.csv", fields, rows)
        results[name] = rows
    con.commit()
    return results


def independent_checks(users, events, orders, result):
    # 从Python原始字典独立计算，对照SQL；不读取SQL view作为校验来源。
    valid = {u["user_id"]: u for u in users if not u["is_test"]}
    first = stamp(datetime.combine(START, time()))
    end = stamp(CUTOFF)
    scoped = [e for e in events if e["user_id"] in valid and first <= e["event_at"] < end and e["ingest_at"] < end]
    clean = {}
    for e in scoped:
        key = e["event_uuid"]
        if key not in clean or (e["ingest_at"], e["raw_id"]) > (clean[key]["ingest_at"], clean[key]["raw_id"]):
            clean[key] = e
    activity = {(e["user_id"], e["event_at"][:10]) for e in clean.values() if e["event_name"] == "launch"}
    latest = {}
    for o in orders:
        if o["user_id"] not in valid or not first <= o["created_at"] < end or o["updated_at"] >= end:
            continue
        key = o["order_id"]
        if key not in latest or (o["updated_at"], o["raw_id"]) > (latest[key]["updated_at"], latest[key]["raw_id"]):
            latest[key] = o
    paid = [o for o in latest.values() if o["status"] == "paid"]
    payers = {o["user_id"] for o in paid if o["amount_cents"] > o["refund_cents"]}
    gross = sum(o["amount_cents"] for o in paid)
    refund = sum(o["refund_cents"] for o in paid)
    eligible = [u for u in valid.values() if u["signup_at"][:10] <= "2026-09-30"]
    retained = [u for u in eligible if (u["user_id"], (date.fromisoformat(u["signup_at"][:10]) + timedelta(days=7)).isoformat()) in activity]
    overview = result["01_overview"][0]
    checks = {
        "registered_users_independent": overview["registered_users"] == len(valid),
        "deduplicated_events_independent": overview["clean_event_count"] == len(clean),
        "active_users_independent": overview["active_users"] == len({a[0] for a in activity}),
        "net_payers_independent": overview["net_paying_users"] == len(payers),
        "gross_revenue_independent": round(overview["gross_paid_yuan"] * 100) == gross,
        "refunds_independent": round(overview["refunded_yuan"] * 100) == refund,
        "net_revenue_independent": round(overview["net_revenue_yuan"] * 100) == gross - refund,
        "d7_denominator_independent": sum(r["eligible_users"] for r in result["04_retention_cohorts"]) == len(eligible),
        "d7_numerator_independent": sum(r["retained_d7_users"] for r in result["04_retention_cohorts"]) == len(retained),
        "channel_revenue_reconciles": round(sum(r["net_revenue_yuan"] for r in result["03_channel_metrics"]) * 100) == gross - refund,
        "daily_revenue_reconciles": round(sum(r["net_revenue_yuan"] for r in result["02_daily_metrics"]) * 100) == gross - refund,
        "daily_unique_activity_reconciles": sum(r["dau"] for r in result["02_daily_metrics"]) == len(activity),
        "positive_orders_and_payers_have_launch": payers.issubset({a[0] for a in activity}),
        "d7_censored_users_excluded": len(eligible) < len(valid),
        "all_rates_in_unit_interval": all(0 <= r["d7_retention_rate"] <= 1 for r in result["04_retention_cohorts"]),
        "first_6_rolling_means_unavailable": all(r["dau_7day_mean"] is None for r in result["02_daily_metrics"][:6]),
    }
    assert all(checks.values()), json.dumps(checks, ensure_ascii=False)
    return {"all_passed": True, "checks": checks, "check_count": len(checks),
            "eligible_d7_users": len(eligible), "retained_d7_users": len(retained),
            "d7_retention_rate": len(retained) / len(eligible),
            "valid_scope_event_rows": len(scoped), "deduplicated_events": len(clean),
            "removed_retransmission_rows": len(scoped) - len(clean)}


def draw_charts(result, checks):
    # 标准库分析保持独立；Pillow只用于绘制导出图，不参与计算。
    from PIL import Image, ImageDraw, ImageFont
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    def font(size):
        return ImageFont.truetype(str(font_path), size) if font_path.exists() else ImageFont.load_default(size=size)
    navy, blue, orange, gray = "#142942", "#315CD0", "#E58C34", "#667085"
    W, H = 1400, 850
    charts = ROOT / "charts"
    charts.mkdir(exist_ok=True)
    image = Image.new("RGB", (W, H), "#F8FAFD")
    d = ImageDraw.Draw(image)
    d.text((65, 35), "模拟数据｜每日活跃用户", font=font(35), fill=navy)
    d.text((65, 92), "2026-09-01 至 2026-10-07 · 去重用户数 · 仅用于 SQL 学习作品", font=font(22), fill=gray)
    left, right, top, bottom = 105, 1335, 200, 665
    daily = result["02_daily_metrics"]
    maximum = int(math.ceil(max(r["dau"] for r in daily) / 50) * 50)
    for val in range(0, maximum + 1, 50):
        y = bottom - val / maximum * (bottom - top)
        d.line((left, y, right, y), fill="#DFE5EE", width=2)
        d.text((left - 55, y - 13), str(val), font=font(20), fill=gray)
    def xy(i, val):
        return left + i / (len(daily) - 1) * (right - left), bottom - val / maximum * (bottom - top)
    d.line([xy(i, r["dau"]) for i, r in enumerate(daily)], fill=blue, width=5)
    d.line([xy(i, r["dau_7day_mean"]) for i, r in enumerate(daily) if r["dau_7day_mean"] is not None], fill=orange, width=5)
    for i in [0, 6, 13, 20, 27, 36]:
        x = xy(i, 0)[0]
        d.text((x - 36, bottom + 20), daily[i]["day"][5:], font=font(20), fill=gray)
    d.line((left, 155, left + 45, 155), fill=blue, width=5)
    d.text((left + 58, 140), "DAU", font=font(23), fill=navy)
    d.line((left + 195, 155, left + 240, 155), fill=orange, width=5)
    d.text((left + 254, 140), "7日移动平均（前6日不计算）", font=font(23), fill=navy)
    d.text((65, 760), "趋势受模拟注册规模与衰减规则影响；未发生真实业务优化，也不能解释为增长效果。", font=font(21), fill=gray)
    image.save(charts / "01_dau.png")

    image = Image.new("RGB", (W, H), "#F8FAFD")
    d = ImageDraw.Draw(image)
    d.text((65, 35), "模拟数据｜渠道指标与样本数", font=font(35), fill=navy)
    d.text((65, 92), "两项指标各有独立分母；渠道差异来自生成规则，不能据此判断真实渠道价值", font=font(22), fill=gray)
    channels = {r["channel"]: r for r in result["03_channel_metrics"]}
    retention = {r["channel"]: r for r in result["05_retention_channels"]}
    panels = [("观察期活跃用户付费转化", "active_to_pay_rate", blue, channels, "active_users"),
              ("成熟注册队列 D7 留存", "d7_retention_rate", orange, retention, "eligible_users")]
    for panel, (title, metric, color, source, denom_key) in enumerate(panels):
        L = 115 + panel * 670
        R = L + 530
        T, B = 225, 610
        d.text((L, 155), title, font=font(26), fill=navy)
        ymax = max(.2, math.ceil(max(source[c][metric] for c in CHANNELS) * 10) / 10)
        for tick in range(5):
            val = tick / 4 * ymax
            y = B - val / ymax * (B - T)
            d.line((L, y, R, y), fill="#DFE5EE", width=2)
            d.text((L - 58, y - 12), f"{val:.0%}", font=font(18), fill=gray)
        for i, c in enumerate(CHANNELS):
            value = source[c][metric]
            x = L + 35 + i * 132
            y = B - value / ymax * (B - T)
            d.rectangle((x, y, x + 65, B), fill=color)
            d.text((x - 4, y - 34), f"{value:.1%}", font=font(21), fill=navy)
            label = {"organic": "自然", "paid_search": "搜索", "campus": "校园", "referral": "推荐"}[c]
            d.text((x + 4, B + 18), label, font=font(22), fill=navy)
            numerator = source[c]["net_paying_users"] if panel == 0 else source[c]["retained_d7_users"]
            d.text((x - 13, B + 54), f"{numerator}/{source[c][denom_key]}", font=font(18), fill=gray)
    d.text((65, 745), "柱下方为分子/分母。付费剔除全额退款；D7排除10-01之后注册且观察不足7日的用户。", font=font(21), fill=gray)
    d.text((65, 784), "全量为模拟数据，非真实用户、企业收入或广告投放数据。", font=font(21), fill=gray)
    image.save(charts / "02_channel_metrics.png")


def write_reports(result, checks, users, events, orders):
    o = result["01_overview"][0]
    quality = {r["check_name"]: r["records"] for r in result["08_data_quality"]}
    cohort_n, retained_n = checks["eligible_d7_users"], checks["retained_d7_users"]
    late_n = quality["unmatured_d7_users"]
    channel_rows = []
    retention = {r["channel"]: r for r in result["05_retention_channels"]}
    for r in result["03_channel_metrics"]:
        t = retention[r["channel"]]
        channel_rows.append(f"| {CHANNEL_NAMES[r['channel']]} | {r['registered_users']} | {r['active_users']} | {r['net_paying_users']} | {r['active_to_pay_rate']:.2%} | {t['retained_d7_users']}/{t['eligible_users']} | {t['d7_retention_rate']:.2%} |")
    reg_rate, active_rate = o["registered_to_pay_rate"], o["active_to_pay_rate"]
    maxchannel = max(result["03_channel_metrics"], key=lambda r: r["active_to_pay_rate"])
    minchannel = min(result["03_channel_metrics"], key=lambda r: r["active_to_pay_rate"])
    report = f"""# AI工具产品用户行为分析：模拟数据 SQL 学习作品

**所有数据均由确定随机种子生成，没有真实企业、用户、收入或投放数据。作品由 AI 辅助创建于 2026-10-08，不是此前完成的实习或商业项目。分析结论没有商业验证。**

## 结果与口径

观察期为 **2026-09-01 至 2026-10-07（37日）**，时间统一按 Asia/Shanghai。截止快照为 2026-10-08 00:00:00，采用左闭右开时间区间。数据设定是一个虚构的 AI 工具产品，包含注册、启动、功能浏览、核心操作、付费墙浏览与订单快照。

| 指标 | SQL实际计算值 | 样本/定义 |
| --- | ---: | --- |
| 有效注册用户 | {o['registered_users']:,} 人 | 原始1,200人剔除24名测试用户 |
| 观察期活跃用户 | {o['active_users']:,} 人 | 至少发生一次 launch，按 user_id 去重 |
| 清洗后事件 | {o['clean_event_count']:,} 条 | 范围过滤、测试/不存在用户排除、event_uuid 去重 |
| 平均 DAU | {o['average_dau']:.2f} 人/日 | 37个自然日全部纳入，每日不同活跃用户数之和/37 |
| 净付费用户 | {o['net_paying_users']:,} 人 | 至少有一个已支付且扣退款后金额大于0的订单 |
| 已支付订单 | {o['paid_orders']:,} 笔 | 订单快照去重后状态paid，包含后续全额退款订单 |
| 正净额订单 | {o['net_positive_orders']:,} 笔 | 已支付且 amount_cents-refund_cents>0 |
| 注册用户付费转化 | {reg_rate:.2%} | {o['net_paying_users']}/{o['registered_users']}；观察期并不等长 |
| 活跃用户付费转化 | {active_rate:.2%} | {o['net_paying_users']}/{o['active_users']} |
| 支付总额 | ¥{o['gross_paid_yuan']:,.2f} | 去重后已支付订单 amount_cents之和/100 |
| 已退款金额 | ¥{o['refunded_yuan']:,.2f} | 截止快照前已确认的refund_cents之和/100 |
| 净收入（练习口径） | ¥{o['net_revenue_yuan']:,.2f} | 支付总额-已退款，不含失败/待支付；非会计收入 |
| 注册用户 ARPU | ¥{o['arpu_registered_yuan']:.2f} | 净收入/{o['registered_users']}名有效注册用户 |
| ARPPU | ¥{o['arppu_yuan']:.2f} | 净收入/{o['net_paying_users']}名净付费用户 |
| 注册队列 D7 留存 | {checks['d7_retention_rate']:.2%} | {retained_n}/{cohort_n}名成熟注册用户，第7个自然日当天有launch |

## 数据质量处理

- 原始事件 **{len(events):,}条**，包含测试用户、越界时间、无对应用户与事件重传。有效范围事件记录为{checks['valid_scope_event_rows']:,}条，删除重传 **{checks['removed_retransmission_rows']:,}条**，得到{checks['deduplicated_events']:,}个业务事件。原始ID是导入行号，event_uuid才是业务事件键。
- 原始订单快照 **{len(orders):,}条**，以order_id为业务键，用ROW_NUMBER保留截止日前最新快照。同金额/用户的不同order_id仍是不同订单，不能误删。
- 全额退款订单 **{quality['fully_refunded_paid_orders']}笔**不计净付费用户和正净额订单；部分退款 **{quality['partially_refunded_paid_orders']}笔**按剩余净额计入。仅有全额退款订单的用户不属于净付费用户。
- 10-01至10-07注册的 **{late_n}人**尚未获得完整D7观察窗，从留存分母中排除。未到观察窗不等于流失。
- 每日收入按订单创建日归属，并采用截止日退款快照回溯重算。它不是每日退款现金流，不适合替代财务核算。
- 事件和订单均先按用户聚合再关联渠道，避免“一人多事件 × 多订单”的JOIN造成收入重复。

## 可以解释的发现

1. 同一组净付费用户，以全体有效注册为分母时为 **{reg_rate:.2%}**，以观察期活跃用户为分母时为 **{active_rate:.2%}**，相差 **{(active_rate-reg_rate)*100:.2f}个百分点**。这展示口径差异，不是提升结果。报告应同时写分子、分母、窗口和退款规则。
2. 当前成熟注册队列D7留存为 **{retained_n}/{cohort_n}={checks['d7_retention_rate']:.2%}**。若误把{late_n}名未成熟用户当作未留存纳入分母，会变成 **{retained_n/o['registered_users']:.2%}**，导致低估。不能将两者混用。
3. 模拟渠道中活跃用户付费率最高的是{CHANNEL_NAMES[maxchannel['channel']]}（**{maxchannel['net_paying_users']}/{maxchannel['active_users']}={maxchannel['active_to_pay_rate']:.2%}**），最低的是{CHANNEL_NAMES[minchannel['channel']]}（**{minchannel['net_paying_users']}/{minchannel['active_users']}={minchannel['active_to_pay_rate']:.2%}**）。生成器直接设定了渠道活跃差异，同时注册日期分布、抽样噪声和重复访问次数不同，因此不能得出真实渠道优劣或投放建议。

| 模拟渠道 | 注册 | 活跃 | 净付费 | 活跃付费率 | D7分子/分母 | D7留存 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
{chr(10).join(channel_rows)}

![模拟每日活跃用户](charts/01_dau.png)

![模拟渠道指标与样本数](charts/02_channel_metrics.png)

## 待验证问题与后续练习

- 如换成经授权的真实数据，需要先核验埋点完整性、业务事件ID稳定性、用户主键、支付和退款时间以及跨时区处理。
- 可新增同龄用户队列付费比较，控制注册时间与观察长度；目前转化是观察期覆盖率，不是每个用户注册后7天转化。
- 如设计实验，需定义主指标/护栏指标、随机分流、样本量和观察期，再分析置信区间。本作品没有开展A/B实验、没有效果提升结论。
- 行为覆盖查询统计“期间至少发生一次”各行为，未施加时序约束，不能称严格顺序漏斗。可另写带事件时间约束的漏斗作为练习。

## 复现与验证

随机种子：**{SEED}**。SQLite查询实际执行，生成8份结果CSV。Python从原始字典独立计算事件去重、活跃、付费、金额与D7分子分母，并与SQL对照；另验证渠道/日度金额和总额对账、滚动平均边界。共 **{checks['check_count']}项**全部通过，见`validation.json`。不将校验通过等同于商业结论成立。

此作品可以用于学习和展示SQL实践。本人完成理解、修改及独立复现之前，不宜写成“独立完成”或已掌握所有涉及的技能。
"""
    (ROOT / "分析报告.md").write_text(report, encoding="utf-8")
    cards = [("有效注册用户", f"{o['registered_users']:,}", "剔除测试账户"),
             ("活跃付费转化", f"{active_rate:.2%}", f"{o['net_paying_users']}/{o['active_users']}"),
             ("成熟队列 D7", f"{checks['d7_retention_rate']:.2%}", f"{retained_n}/{cohort_n}"),
             ("模拟净收入", f"¥{o['net_revenue_yuan']:,.2f}", "非真实企业收入")]
    card_html = ''.join(f'<div class="card"><span>{a}</span><strong>{b}</strong><small>{c}</small></div>' for a,b,c in cards)
    table_html = ''.join('<tr>' + ''.join(f'<td>{html.escape(str(v))}</td>' for v in [CHANNEL_NAMES[r['channel']],r['registered_users'],r['active_users'],r['net_paying_users'],f"{r['active_to_pay_rate']:.2%}",f"{retention[r['channel']]['retained_d7_users']}/{retention[r['channel']]['eligible_users']}",f"{retention[r['channel']]['d7_retention_rate']:.2%}"]) + '</tr>' for r in result['03_channel_metrics'])
    pictures = []
    for name in ["01_dau.png", "02_channel_metrics.png"]:
        data = base64.b64encode((ROOT / "charts" / name).read_bytes()).decode()
        pictures.append(f'<img src="data:image/png;base64,{data}" alt="模拟数据图表">')
    full_html = f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>模拟数据 SQL 学习作品</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#edf1f7;color:#142942;font:16px/1.8 'Microsoft YaHei','PingFang SC',sans-serif}}main{{max-width:1120px;margin:34px auto;padding:40px;background:white;border-radius:18px}}h1{{font-size:34px;line-height:1.4;margin:8px 0}}h2{{font-size:23px;margin:35px 0 10px}}.eyebrow{{font-weight:bold;color:#315cd0;letter-spacing:2px}}.note{{background:#fff4dd;border-left:4px solid #e58c34;padding:16px 22px;border-radius:6px;color:#684315}}.meta,small{{color:#667085}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:26px 0}}.card{{padding:20px;border:1px solid #dbe3ef;border-radius:10px}}.card span,.card strong,.card small{{display:block}}.card strong{{font-size:30px;margin:5px 0;color:#315cd0}}table{{width:100%;border-collapse:collapse;font-size:15px}}th{{background:#142942;color:white;text-align:right;padding:12px}}td{{padding:11px;text-align:right;border-bottom:1px solid #e6ebf2}}td:first-child,th:first-child{{text-align:left}}img{{width:100%;border:1px solid #edf1f7;border-radius:12px;margin:15px 0}}.footer{{border-top:1px solid #dbe3ef;padding-top:20px;margin-top:28px;color:#667085}}a{{color:#315cd0}}@media(max-width:720px){{main{{margin:0;padding:22px;border-radius:0}}h1{{font-size:27px}}.cards{{grid-template-columns:repeat(2,1fr)}}.tablewrap{{overflow:auto}}}}</style>
<main><div class="eyebrow">SQL 学习作品 · AI 辅助创建</div><h1>AI工具产品用户行为分析</h1><p class="meta">固定种子 {SEED} · 2026-09-01 至 2026-10-07 · 37日观察窗 · 制作日期 2026-10-08</p>
<p class="note"><b>全部数据为模拟。</b>没有真实企业、用户、收入或广告投放数据。本作品不是此前完成的实习项目，没有经过商业验证。</p>
<div class="cards">{card_html}</div><h2>分母决定指标的含义</h2><p>{o['net_paying_users']}名净付费用户 ÷ {o['registered_users']}名有效注册用户 = <b>{reg_rate:.2%}</b>；÷ {o['active_users']}名观察期活跃用户 = <b>{active_rate:.2%}</b>。二者相差{(active_rate-reg_rate)*100:.2f}个百分点，源于口径变化，不能写成增长提升。</p>
<h2>留存需要完整观察窗口</h2><p>D7为注册后第7个自然日当天有启动事件。成熟样本{cohort_n}人，回访{retained_n}人；10-01之后注册的{late_n}人尚未成熟，排除在分母之外。原始启动重传与同日多次启动均去重。</p>
<h2>日活走势</h2>{pictures[0]}<h2>渠道样本与结果</h2><div class="tablewrap"><table><thead><tr><th>模拟渠道</th><th>注册</th><th>活跃</th><th>净付费</th><th>活跃付费率</th><th>D7分子/分母</th><th>D7留存</th></tr></thead><tbody>{table_html}</tbody></table></div>{pictures[1]}
<h2>查询与数据质量</h2><p>使用JOIN、GROUP BY、子查询、CTE、ROW_NUMBER、DENSE_RANK及滚动窗口；事件按event_uuid去重，订单按order_id取截止日前最新快照。清洗后{o['clean_event_count']:,}条事件，剔除有效范围内{checks['removed_retransmission_rows']:,}条重传。先按用户聚合再JOIN，避免一人多事件与多订单造成收入重复。</p>
<p>支付总额¥{o['gross_paid_yuan']:,.2f}，已退款¥{o['refunded_yuan']:,.2f}，净收入¥{o['net_revenue_yuan']:,.2f}。全额退款订单不计净付费用户，部分退款按剩余金额计算；待支付/失败订单排除。日度金额按订单创建日回溯归属，不是财务现金流。</p>
<h2>结论边界与后续练习</h2><p>渠道差异由模拟概率、用户年龄与抽样噪声决定，不能形成真实投放建议。后续可练习同龄注册队列、严格时序漏斗和实验样本量；当前没有开展A/B实验，没有真实效果提升。</p>
<p>Python从原始数据独立计算并对照SQL，{checks['check_count']}项校验全部通过。SQL结果CSV与复现命令见目录README。</p><div class="footer">完整口径见 <a href="分析报告.md">分析报告</a> · <a href="README.md">运行说明</a> · <a href="analysis.sql">SQL查询</a><br>必须理解、修改和独立复现后，再根据本人实际完成情况描述学习作品。</div></main></html>"""
    (ROOT / "分析报告.html").write_text(full_html, encoding="utf-8")


def main():
    users, events, orders = generate()
    con = build_database(users, events, orders)
    try:
        result = execute_queries(con)
        checks = independent_checks(users, events, orders, result)
    finally:
        con.close()
    draw_charts(result, checks)
    write_reports(result, checks, users, events, orders)
    hashes = {str(path.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest()
              for path in sorted((ROOT / "data").glob("*.csv")) + sorted((ROOT / "results").glob("*.csv"))}
    validation = {"data_source": "synthetic_only", "ai_assisted_creation": True,
                  "seed": SEED, "period_start": START.isoformat(), "period_end": END.isoformat(),
                  "timezone": "Asia/Shanghai", "snapshot_cutoff_exclusive": stamp(CUTOFF),
                  "sqlite_version": sqlite3.sqlite_version, **checks, "csv_sha256": hashes}
    (ROOT / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"overview": result["01_overview"][0], "validation": {k:v for k,v in checks.items() if k != "checks"},
                      "raw_users": len(users), "raw_events": len(events), "raw_order_snapshots": len(orders)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
