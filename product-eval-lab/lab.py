"""Local, dependency-free experiments for retrieval, bounded agents and growth analysis."""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def tokens(text):
    return re.findall(r"[a-z0-9]+|[\u4e00-\u9fff]", text.lower())


class Retriever:
    def __init__(self, documents):
        ids = [d['id'] for d in documents]
        if len(ids) != len(set(ids)):
            raise ValueError('duplicate document ids')
        self.docs = documents
        self.counts = [Counter(tokens(d['text'])) for d in documents]
        self.lengths = [sum(c.values()) for c in self.counts]
        self.avg = sum(self.lengths) / max(1, len(documents))

    def search(self, query, k=3, method='bm25', current_only=False):
        if k < 1 or method not in ('overlap', 'bm25'):
            raise ValueError('invalid retrieval configuration')
        query = set(tokens(query))
        scored = []
        for i, doc in enumerate(self.docs):
            if current_only and not doc['current']:
                continue
            count = self.counts[i]
            score = 0.0
            for word in query:
                tf = count[word]
                if not tf:
                    continue
                if method == 'overlap':
                    score += 1
                else:
                    df = sum(word in c for c in self.counts)
                    idf = math.log(1 + (len(self.docs) - df + .5) / (df + .5))
                    score += idf * tf * 2.5 / (tf + 1.5 * (.25 + .75 * self.lengths[i] / self.avg))
            if score > 0:
                scored.append((score, doc['id'], doc))
        return [dict(doc, score=round(score, 6)) for score, _, doc in sorted(scored, key=lambda r: (-r[0], r[1]))[:k]]


def retrieval_metrics(ids, relevant, k=3):
    relevant = set(relevant)
    if not relevant:
        raise ValueError('retrieval metrics require nonempty relevance labels')
    if len(ids) != len(set(ids)):
        raise ValueError('ranked ids must be unique')
    ranked = ids[:k]
    hits = [int(x in relevant) for x in ranked]
    recall = sum(hits) / len(relevant)
    reciprocal = next((1 / (i + 1) for i, hit in enumerate(hits) if hit), 0)
    dcg = sum(hit / math.log2(i + 2) for i, hit in enumerate(hits))
    ideal = sum(1 / math.log2(i + 2) for i in range(min(k, len(relevant))))
    return {'recall_at_3': recall, 'mrr_at_3': reciprocal, 'ndcg_at_3': dcg / ideal}


class AgentError(ValueError):
    pass


def run_agent(steps, retriever, max_calls=4):
    """Execute declared actions, not model reasoning; every final claim needs observed evidence."""
    trace, observed = [], {}
    for step in steps:
        action, args = step.get('action'), step.get('args', {})
        if not isinstance(args, dict):
            raise AgentError('arguments must be an object')
        if action == 'finish':
            citations, answer = args.get('citations', []), args.get('answer', '')
            if not citations or not isinstance(citations, list) or not isinstance(answer, str):
                raise AgentError('answer and citations required')
            if any(not isinstance(i, str) or i not in observed for i in citations):
                raise AgentError('citation was not read')
            # Extractive mode intentionally avoids pretending that lexical matching proves semantic truth.
            if not any(answer and answer in observed[i]['text'] for i in citations):
                raise AgentError('answer must be a verbatim evidence excerpt')
            trace.append({'action': 'finish', 'answer': answer, 'citations': citations})
            return {'status': 'finished', 'tool_calls': len(trace)-1, 'trace': trace, 'answer': answer}
        if len(trace) >= max_calls:
            raise AgentError('tool call budget exceeded')
        if action == 'search':
            query = args.get('query')
            if not isinstance(query, str) or not query.strip() or len(query) > 500:
                raise AgentError('invalid query')
            result = retriever.search(query, current_only=True)
            observation = [{'id': d['id'], 'title': d['title'], 'score': d['score']} for d in result]
        elif action == 'read':
            doc_id = args.get('id')
            if not isinstance(doc_id, str):
                raise AgentError('invalid document id')
            doc = next((d for d in retriever.docs if d['id'] == doc_id and d['current']), None)
            if doc is None:
                raise AgentError('unknown or stale document')
            observed[doc_id] = doc
            observation = {'id': doc_id, 'text': doc['text'], 'source_type': 'synthetic_document'}
        else:
            raise AgentError('tool is not allowlisted')
        trace.append({'action': action, 'args': args, 'observation': observation})
        if hasattr(steps, 'observe'):
            steps.observe(trace[-1])
    raise AgentError('trajectory ended without a grounded final answer')


def allocation(user_id, experiment, salt='portfolio-lab-v1'):
    digest = hashlib.sha256(f'{salt}:{experiment}:{user_id}'.encode()).digest()
    return 'A' if int.from_bytes(digest[:8], 'big') % 2 == 0 else 'B'


def wilson(successes, n, z=1.959963984540054):
    if n <= 0 or not 0 <= successes <= n:
        raise ValueError('invalid binomial counts')
    p = successes / n
    den = 1 + z*z/n
    center = (p + z*z/(2*n))/den
    radius = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/den
    return [max(0., center-radius), min(1., center+radius)]


def experiment(a_n, a_pay, b_n, b_pay, a_refunds=0, b_refunds=0):
    for n, paid, refunds in ((a_n, a_pay, a_refunds), (b_n, b_pay, b_refunds)):
        if not all(type(v) is int for v in (n, paid, refunds)) or n < 30 or not 0 <= refunds <= paid <= n:
            raise ValueError('invalid or too small aggregated counts')
    total = a_n+b_n
    srm_z = (a_n-total/2) / math.sqrt(total*.25)
    srm_p = math.erfc(abs(srm_z)/math.sqrt(2))
    pa, pb = a_pay/a_n, b_pay/b_n
    pooled = (a_pay+b_pay)/total
    variance = pooled*(1-pooled)*(1/a_n+1/b_n)
    z = (pb-pa)/math.sqrt(variance) if variance else 0.
    p = math.erfc(abs(z)/math.sqrt(2)) if variance else 1.
    ia, ib = wilson(a_pay, a_n), wilson(b_pay, b_n)
    diff_ci = [pb-pa-math.sqrt((pb-ib[0])**2+(ia[1]-pa)**2),
               pb-pa+math.sqrt((ib[1]-pb)**2+(pa-ia[0])**2)]
    sparse = min(a_pay, b_pay, a_n-a_pay, b_n-b_pay) < 5
    return {'a_rate': pa, 'b_rate': pb, 'difference': pb-pa,
            'difference_ci95': diff_ci, 'p_value': p,
            'srm_p_value': srm_p, 'srm_passed': srm_p >= .001,
            'a_refund_rate': a_refunds/a_pay if a_pay else None,
            'b_refund_rate': b_refunds/b_pay if b_pay else None,
            'approximation_valid': not sparse,
            'status': 'insufficient_counts' if sparse else ('allocation_mismatch' if srm_p < .001 else 'analysis_ready'),
            'method': 'two-sided pooled z; Newcombe-Wilson difference interval; equal-allocation normal SRM approximation',
            'decision_scope': 'fixed-horizon synthetic analysis; refund guardrail and practical effect need separate decisions'}


def strict_funnel(events, assigned_at, window=7*86400):
    """Synthetic epoch seconds; deduplicate, enforce time/session/order coherence."""
    unique = {e['event_id']: e for e in events}
    rows = sorted((e for e in unique.values() if 0 <= e['time']-assigned_at < window), key=lambda e: (e['time'], e['event_id']))
    paths = []
    for exposure in rows:
        if exposure['type'] != 'exposure':
            continue
        eligible = [e for e in rows if e['user'] == exposure['user'] and e['session'] == exposure['session'] and e['time'] >= exposure['time']]
        for plan in eligible:
            if plan['type'] != 'plan':
                continue
            for order in eligible:
                if order['type'] != 'order' or order['time'] < plan['time'] or not order.get('order_id'):
                    continue
                paid = next((e for e in eligible if e['type']=='paid' and e['time']>=order['time'] and e.get('order_id')==order['order_id']), None)
                if paid:
                    paths.append({'user': exposure['user'], 'session': exposure['session'], 'order_id':order['order_id']})
    return list({(p['user'], p['session'], p['order_id']):p for p in paths}.values())


def canonical_output(value):
    """Keep 12 significant digits so libm's final-bit differences do not alter artifacts."""
    if isinstance(value, float):
        return float(format(value, '.12g'))
    if isinstance(value, dict):
        return {key: canonical_output(item) for key, item in value.items()}
    if isinstance(value, list):
        return [canonical_output(item) for item in value]
    return value


def evaluate():
    data = json.loads((ROOT/'fixtures.json').read_text(encoding='utf-8'))
    retriever = Retriever(data['documents'])
    variants = [('overlap', False), ('bm25', False), ('bm25', True)]
    retrieval = []
    for method, filtered in variants:
        cases = []
        for q in data['queries']:
            hits = retriever.search(q['query'], method=method, current_only=filtered)
            ids = [d['id'] for d in hits]
            cases.append({'id':q['id'], 'query':q['query'], 'relevant':q['relevant'], 'ranked':ids,
                          **retrieval_metrics(ids,q['relevant'])})
        retrieval.append({'method': method+('_current' if filtered else ''), 'n':len(cases),
                          'metrics':{key:sum(c[key] for c in cases)/len(cases) for key in ['recall_at_3','mrr_at_3','ndcg_at_3']}, 'cases':cases})
    trajectories = []
    for case in data['agent_cases']:
        try:
            result = run_agent(case['steps'], retriever, case.get('budget',4))
            got = 'finished'
        except AgentError as exc:
            result = {'status':'rejected','reason':str(exc)}
            got = 'rejected'
        trajectories.append({'id':case['id'],'scenario':case['scenario'],'expected':case['expected'],'passed':got==case['expected'],**result})
    growth = [dict(name=name,**experiment(**counts)) for name,counts in data['experiments'].items()]
    result = canonical_output({'scope':'synthetic fixtures; ReAct-style orchestration with scripted decisions; lexical retrieval, no LLM benchmark',
              'fixture_sha256':hashlib.sha256((ROOT/'fixtures.json').read_bytes()).hexdigest(),
              'retrieval':retrieval,'agent':trajectories,'growth':growth})
    target = ROOT/'results'
    target.mkdir(exist_ok=True)
    (target/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')
    return result


if __name__ == '__main__':
    report=evaluate()
    print(json.dumps({'retrieval':[{k:v for k,v in x.items() if k!='cases'} for x in report['retrieval']],
                      'agent_contract_checks':f"{sum(x['passed'] for x in report['agent'])}/{len(report['agent'])}",
                      'growth':[{'name':x['name'],'status':x['status']} for x in report['growth']]},ensure_ascii=False,indent=2))
