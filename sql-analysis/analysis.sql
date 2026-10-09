-- AI工具产品的模拟用户行为分析：仅供SQL练习，非企业或真实用户数据。
-- 数据区间 2026-09-01 至 2026-10-07，时区 Asia/Shanghai。
-- 所有时间采用左闭右开区间 [2026-09-01 00:00:00, 2026-10-08 00:00:00)。
-- SQLite 3.25+。本文件可完整执行；脚本还会将标记后的结果导出CSV。

-- SETUP BEGIN
DROP VIEW IF EXISTS clean_events;
CREATE VIEW clean_events AS
WITH scoped AS (
    SELECT e.*, ROW_NUMBER() OVER (
        PARTITION BY e.event_uuid ORDER BY e.ingest_at DESC, e.raw_id DESC
    ) AS retransmit_rank
    FROM events_raw e JOIN users u ON u.user_id = e.user_id
    WHERE u.is_test = 0 AND e.event_at >= '2026-09-01 00:00:00'
      AND e.event_at < '2026-10-08 00:00:00'
      AND e.ingest_at < '2026-10-08 00:00:00'
)
SELECT raw_id, event_uuid, user_id, event_name, event_at, ingest_at
FROM scoped WHERE retransmit_rank = 1;

DROP VIEW IF EXISTS clean_orders;
CREATE VIEW clean_orders AS
WITH snapshots AS (
    SELECT o.*, ROW_NUMBER() OVER (
        PARTITION BY o.order_id ORDER BY o.updated_at DESC, o.raw_id DESC
    ) AS snapshot_rank
    FROM orders_raw o JOIN users u ON u.user_id = o.user_id
    WHERE u.is_test = 0 AND o.created_at >= '2026-09-01 00:00:00'
      AND o.created_at < '2026-10-08 00:00:00'
      AND o.updated_at < '2026-10-08 00:00:00'
)
SELECT raw_id, order_id, user_id, created_at, updated_at, status,
       amount_cents, refund_cents,
       CASE WHEN status = 'paid' THEN amount_cents - refund_cents ELSE 0 END AS net_cents
FROM snapshots WHERE snapshot_rank = 1;

DROP VIEW IF EXISTS user_activity;
DROP TABLE IF EXISTS user_activity_cache;
-- 只物化一次用户日去重结果，避免D7关联子查询反复执行事件窗口去重。
-- 更新raw数据后需重新运行SETUP区刷新缓存。
CREATE TABLE user_activity_cache AS
SELECT DISTINCT user_id, DATE(event_at) AS activity_date
FROM clean_events WHERE event_name = 'launch';
CREATE UNIQUE INDEX activity_user_day ON user_activity_cache(user_id, activity_date);
CREATE VIEW user_activity AS SELECT user_id, activity_date FROM user_activity_cache;
-- SETUP END

-- RESULT: 01_overview
WITH counts AS (
    SELECT
      (SELECT COUNT(*) FROM users WHERE is_test = 0) AS registered_users,
      (SELECT COUNT(DISTINCT user_id) FROM user_activity) AS active_users,
      (SELECT COUNT(*) FROM clean_events) AS clean_event_count,
      (SELECT COUNT(*) FROM clean_orders WHERE status = 'paid') AS paid_orders,
      (SELECT COUNT(*) FROM clean_orders WHERE status = 'paid' AND net_cents > 0) AS net_positive_orders,
      (SELECT COUNT(DISTINCT user_id) FROM clean_orders WHERE status = 'paid' AND net_cents > 0) AS net_paying_users,
      (SELECT SUM(amount_cents) FROM clean_orders WHERE status = 'paid') AS gross_cents,
      (SELECT SUM(refund_cents) FROM clean_orders WHERE status = 'paid') AS refund_cents,
      (SELECT SUM(net_cents) FROM clean_orders WHERE status = 'paid') AS net_cents,
      (SELECT COUNT(*) FROM user_activity) AS active_user_days
)
SELECT '2026-09-01' AS period_start, '2026-10-07' AS period_end,
       registered_users, active_users, clean_event_count, paid_orders,
       net_positive_orders, net_paying_users,
       ROUND(gross_cents / 100.0, 2) AS gross_paid_yuan,
       ROUND(refund_cents / 100.0, 2) AS refunded_yuan,
       ROUND(net_cents / 100.0, 2) AS net_revenue_yuan,
       ROUND(1.0 * net_paying_users / NULLIF(registered_users, 0), 6) AS registered_to_pay_rate,
       ROUND(1.0 * net_paying_users / NULLIF(active_users, 0), 6) AS active_to_pay_rate,
       ROUND(net_cents / 100.0 / NULLIF(registered_users, 0), 2) AS arpu_registered_yuan,
       ROUND(net_cents / 100.0 / NULLIF(net_paying_users, 0), 2) AS arppu_yuan,
       ROUND(active_user_days / 37.0, 2) AS average_dau
FROM counts;

-- RESULT: 02_daily_metrics
WITH daily AS (
    SELECT c.day,
      (SELECT COUNT(*) FROM users u WHERE u.is_test = 0 AND DATE(u.signup_at) = c.day) AS new_users,
      (SELECT COUNT(*) FROM user_activity a WHERE a.activity_date = c.day) AS dau,
      (SELECT COUNT(DISTINCT o.user_id) FROM clean_orders o
       WHERE o.status = 'paid' AND o.net_cents > 0 AND DATE(o.created_at) = c.day) AS net_paying_users,
      COALESCE((SELECT SUM(o.net_cents) FROM clean_orders o
       WHERE o.status = 'paid' AND DATE(o.created_at) = c.day), 0) / 100.0 AS net_revenue_yuan
    FROM calendar c
)
SELECT *,
       CASE WHEN ROW_NUMBER() OVER (ORDER BY day) >= 7
            THEN ROUND(AVG(dau) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2)
       END AS dau_7day_mean,
       ROUND(SUM(net_revenue_yuan) OVER (ORDER BY day ROWS UNBOUNDED PRECEDING), 2) AS cumulative_net_revenue_yuan
FROM daily ORDER BY day;

-- RESULT: 03_channel_metrics
-- 先聚合到用户粒度，再JOIN，避免一人多事件×多订单导致收入膨胀。
WITH revenue_by_user AS (
    SELECT user_id, SUM(net_cents) AS net_cents,
           COUNT(CASE WHEN status = 'paid' AND net_cents > 0 THEN 1 END) AS net_orders
    FROM clean_orders GROUP BY user_id
), activity_by_user AS (
    SELECT user_id, COUNT(*) AS active_days FROM user_activity GROUP BY user_id
), grouped AS (
    SELECT u.channel, COUNT(*) AS registered_users,
      SUM(CASE WHEN a.active_days > 0 THEN 1 ELSE 0 END) AS active_users,
      SUM(CASE WHEN r.net_cents > 0 THEN 1 ELSE 0 END) AS net_paying_users,
      SUM(COALESCE(r.net_cents, 0)) AS net_cents
    FROM users u LEFT JOIN revenue_by_user r ON r.user_id = u.user_id
    LEFT JOIN activity_by_user a ON a.user_id = u.user_id
    WHERE u.is_test = 0 GROUP BY u.channel
)
SELECT channel, registered_users, active_users, net_paying_users,
       ROUND(1.0 * net_paying_users / NULLIF(registered_users, 0), 6) AS registered_to_pay_rate,
       ROUND(1.0 * net_paying_users / NULLIF(active_users, 0), 6) AS active_to_pay_rate,
       ROUND(net_cents / 100.0, 2) AS net_revenue_yuan
FROM grouped ORDER BY registered_users DESC, channel;

-- RESULT: 04_retention_cohorts
-- D7指注册日+7个自然日“当天launch”，并非第1至7日内任意回访。
-- 只纳入注册日<=09-30的成熟队列；10-01至10-07尚无完整D7观察窗。
WITH mature_users AS (
    SELECT user_id, DATE(signup_at) AS cohort_date FROM users
    WHERE is_test = 0 AND DATE(signup_at) <= '2026-09-30'
)
SELECT m.cohort_date, COUNT(*) AS eligible_users,
       COUNT(a.user_id) AS retained_d7_users,
       ROUND(1.0 * COUNT(a.user_id) / COUNT(*), 6) AS d7_retention_rate
FROM mature_users m LEFT JOIN user_activity a
  ON a.user_id = m.user_id AND a.activity_date = DATE(m.cohort_date, '+7 days')
GROUP BY m.cohort_date ORDER BY m.cohort_date;

-- RESULT: 05_retention_channels
SELECT u.channel, COUNT(*) AS eligible_users,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM user_activity a WHERE a.user_id = u.user_id
           AND a.activity_date = DATE(u.signup_at, '+7 days')
       ) THEN 1 ELSE 0 END) AS retained_d7_users,
       ROUND(1.0 * SUM(CASE WHEN EXISTS (
         SELECT 1 FROM user_activity a WHERE a.user_id = u.user_id
           AND a.activity_date = DATE(u.signup_at, '+7 days')
       ) THEN 1 ELSE 0 END) / COUNT(*), 6) AS d7_retention_rate
FROM users u WHERE u.is_test = 0 AND DATE(u.signup_at) <= '2026-09-30'
GROUP BY u.channel ORDER BY u.channel;

-- RESULT: 06_behavior_coverage
-- 这是观察期内用户行为覆盖，不是严格按时间先后约束的转化漏斗。
WITH flags AS (
    SELECT user_id,
      MAX(event_name = 'launch') AS launched,
      MAX(event_name = 'feature_view') AS viewed,
      MAX(event_name = 'core_action') AS used_core,
      MAX(event_name = 'paywall_view') AS saw_paywall
    FROM clean_events GROUP BY user_id
), coverage AS (
    SELECT 1 AS step_order, 'registered' AS behavior, COUNT(*) AS users
    FROM users WHERE is_test = 0
    UNION ALL SELECT 2, 'launch', SUM(launched) FROM flags
    UNION ALL SELECT 3, 'feature_view', SUM(viewed) FROM flags
    UNION ALL SELECT 4, 'core_action', SUM(used_core) FROM flags
    UNION ALL SELECT 5, 'paywall_view', SUM(saw_paywall) FROM flags
    UNION ALL SELECT 6, 'net_paid', COUNT(DISTINCT user_id)
    FROM clean_orders WHERE status = 'paid' AND net_cents > 0
)
SELECT step_order, behavior, users,
       ROUND(1.0 * users / (SELECT COUNT(*) FROM users WHERE is_test = 0), 6) AS share_of_registered
FROM coverage ORDER BY step_order;

-- RESULT: 07_top_payers
WITH revenue_by_user AS (
    SELECT user_id, SUM(net_cents) AS net_cents, COUNT(*) AS paid_orders,
           MIN(created_at) AS first_payment_at
    FROM clean_orders WHERE status = 'paid' AND net_cents > 0 GROUP BY user_id
), ranked AS (
    SELECT r.*, u.channel,
      DENSE_RANK() OVER (ORDER BY r.net_cents DESC) AS revenue_rank
    FROM revenue_by_user r JOIN users u ON u.user_id = r.user_id
)
SELECT user_id, channel, revenue_rank, paid_orders,
       ROUND(net_cents / 100.0, 2) AS net_revenue_yuan, first_payment_at
FROM ranked WHERE revenue_rank <= 10 ORDER BY revenue_rank, user_id;

-- RESULT: 08_data_quality
SELECT 'raw_events' AS check_name, COUNT(*) AS records FROM events_raw
UNION ALL SELECT 'out_of_window_events', COUNT(*) FROM events_raw
 WHERE event_at < '2026-09-01 00:00:00' OR event_at >= '2026-10-08 00:00:00' OR ingest_at >= '2026-10-08 00:00:00'
UNION ALL SELECT 'unknown_user_events', COUNT(*) FROM events_raw e LEFT JOIN users u ON u.user_id = e.user_id
 WHERE u.user_id IS NULL AND e.event_at >= '2026-09-01 00:00:00' AND e.event_at < '2026-10-08 00:00:00' AND e.ingest_at < '2026-10-08 00:00:00'
UNION ALL SELECT 'test_user_events', COUNT(*) FROM events_raw e JOIN users u ON u.user_id = e.user_id
 WHERE u.is_test = 1 AND e.event_at >= '2026-09-01 00:00:00' AND e.event_at < '2026-10-08 00:00:00' AND e.ingest_at < '2026-10-08 00:00:00'
UNION ALL SELECT 'valid_scope_event_rows', COUNT(*) FROM events_raw e JOIN users u ON u.user_id = e.user_id
 WHERE u.is_test = 0 AND e.event_at >= '2026-09-01 00:00:00' AND e.event_at < '2026-10-08 00:00:00' AND e.ingest_at < '2026-10-08 00:00:00'
UNION ALL SELECT 'deduplicated_events', COUNT(*) FROM clean_events
UNION ALL SELECT 'raw_order_snapshots', COUNT(*) FROM orders_raw
UNION ALL SELECT 'clean_orders_as_of_cutoff', COUNT(*) FROM clean_orders
UNION ALL SELECT 'fully_refunded_paid_orders', COUNT(*) FROM clean_orders WHERE status = 'paid' AND net_cents = 0
UNION ALL SELECT 'partially_refunded_paid_orders', COUNT(*) FROM clean_orders WHERE status = 'paid' AND refund_cents > 0 AND net_cents > 0
UNION ALL SELECT 'unmatured_d7_users', COUNT(*) FROM users WHERE is_test = 0 AND DATE(signup_at) > '2026-09-30';
