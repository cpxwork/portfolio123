"""Offline, synthetic structured-output validation exercise (2026-10-12).

AI-assisted learning exercise. No model or network call is made. It checks
format and task constraints, not whether a paper or summary is factually true.
"""

from __future__ import annotations

import csv
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REQUIRED_FIELDS = ("title", "published_date", "summary", "source_id", "citation_url")


def validate_output(raw_output: str, task: dict) -> list[dict]:
    """Return all observable rule violations; an empty list means rule pass."""
    issues = []

    def add(code: str, location: str, message: str) -> None:
        issues.append({"code": code, "location": location, "message": message})

    try:
        output = json.loads(raw_output)
    except json.JSONDecodeError as exc:
        add("json_parse_failed", "$", f"JSON 解析失败（行 {exc.lineno}，列 {exc.colno}）")
        return issues

    if not isinstance(output, dict) or not isinstance(output.get("papers"), list):
        add("required_field_missing", "$.papers", "必须提供 papers 数组")
        return issues

    papers = output["papers"]
    if len(papers) < task["min_papers"]:
        add("insufficient_count", "$.papers", f"条目数 {len(papers)}，任务至少要求 {task['min_papers']}")

    first_date = date.fromisoformat(task["date_start"])
    last_date = date.fromisoformat(task["date_end"])
    supplied_sources = {s["source_id"]: s for s in task["provided_sources"]}
    supplied_urls = {s["citation_url"] for s in task["provided_sources"]}
    seen_source_ids = set()

    for index, paper in enumerate(papers):
        path = f"$.papers[{index}]"
        if not isinstance(paper, dict):
            add("required_field_missing", path, "每条论文摘要必须是对象")
            continue
        for field in REQUIRED_FIELDS:
            value = paper.get(field)
            if not isinstance(value, str) or not value.strip():
                add("required_field_missing", f"{path}.{field}", "必填字段缺失、为空或不是字符串")

        published_date = paper.get("published_date")
        if isinstance(published_date, str) and published_date.strip():
            try:
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}", published_date) is None:
                    raise ValueError("Expected YYYY-MM-DD")
                parsed_date = date.fromisoformat(published_date)
                if not first_date <= parsed_date <= last_date:
                    add("date_out_of_range", f"{path}.published_date", "日期超出任务指定范围")
            except ValueError:
                add("invalid_date", f"{path}.published_date", "日期必须为有效 YYYY-MM-DD")

        source_id = paper.get("source_id")
        if isinstance(source_id, str) and source_id.strip():
            if source_id in seen_source_ids:
                add("duplicate_source", f"{path}.source_id", "同一来源被重复计为多个条目")
            seen_source_ids.add(source_id)
            if source_id not in supplied_sources:
                add("source_not_provided", f"{path}.source_id", "来源 ID 不属于输入提供的来源")

        citation_url = paper.get("citation_url")
        if isinstance(citation_url, str) and citation_url.strip():
            if citation_url not in supplied_urls:
                add("citation_not_provided", f"{path}.citation_url", "引用地址不属于输入提供的来源地址")
            elif isinstance(source_id, str) and source_id in supplied_sources and citation_url != supplied_sources[source_id]["citation_url"]:
                add("citation_source_mismatch", f"{path}.citation_url", "引用地址与该来源 ID 不匹配")

    return issues


def main() -> int:
    fixtures = json.loads((ROOT / "fixtures.json").read_text(encoding="utf-8"))
    rows = []
    for case in fixtures["cases"]:
        issues = validate_output(case["raw_output"], fixtures["task"])
        actual_codes = sorted({i["code"] for i in issues})
        passed = not issues
        matches_expected = (
            passed == case["expected_rule_pass"]
            and actual_codes == sorted(case["expected_issue_codes"])
        )
        rows.append({
            "case_id": case["case_id"],
            "description": case["description"],
            "expected_rule_pass": case["expected_rule_pass"],
            "actual_rule_pass": passed,
            "expected_issue_codes": case["expected_issue_codes"],
            "actual_issue_codes": actual_codes,
            "matches_expected": matches_expected,
            "issues": issues,
        })

    matched = sum(row["matches_expected"] for row in rows)
    passed = sum(row["actual_rule_pass"] for row in rows)
    results = {
        "exercise": "论文摘要结构化输出核验：离线学习练习",
        "learning_date": fixtures["learning_date"],
        "evaluated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "provenance": fixtures["provenance"],
        "boundary": "人工构造输出；无真实模型调用；无公网事实核验；预期一致率不是模型成功率。",
        "summary": {
            "total_cases": len(rows),
            "rule_pass_cases": passed,
            "rule_reject_cases": len(rows) - passed,
            "expected_match_cases": matched,
            "expected_match_rate": matched / len(rows) if rows else 0,
        },
        "cases": rows,
    }
    (ROOT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with (ROOT / "results.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=[
            "case_id", "description", "expected_rule_pass", "actual_rule_pass",
            "expected_issue_codes", "actual_issue_codes", "matches_expected",
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow({
                **{key: row[key] for key in writer.fieldnames if key not in ("expected_issue_codes", "actual_issue_codes")},
                "expected_issue_codes": ";".join(row["expected_issue_codes"]),
                "actual_issue_codes": ";".join(row["actual_issue_codes"]),
            })

    print("2026-10-12 AI-assisted offline learning exercise; synthetic outputs only.")
    print(f"Expected outcomes matched: {matched}/{len(rows)}")
    print(f"Rule pass: {passed}; rule reject: {len(rows) - passed}")
    print("This is NOT a model success rate or factual evaluation.")
    print(f"Results: {ROOT / 'results.json'}")
    return 0 if matched == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
