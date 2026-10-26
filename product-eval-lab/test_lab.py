import unittest
import json
import math
from pathlib import Path
from lab import Retriever, retrieval_metrics, run_agent, AgentError, allocation, experiment, strict_funnel, wilson

DATA=json.loads((Path(__file__).parent/'fixtures.json').read_text(encoding='utf-8'))

class RetrievalTests(unittest.TestCase):
    def setUp(self): self.r=Retriever(DATA['documents'])
    def test_metrics_known_rank(self):
        m=retrieval_metrics(['x','a','b'],['a','b'])
        self.assertEqual(m['recall_at_3'],1)
        self.assertEqual(m['mrr_at_3'],.5)
        self.assertAlmostEqual(m['ndcg_at_3'],(1/math.log2(3)+.5)/(1+1/math.log2(3)))
    def test_missing_all_relevance(self): self.assertEqual(retrieval_metrics(['x'],['a'])['mrr_at_3'],0)
    def test_empty_labels_not_misleading_perfect_score(self):
        with self.assertRaises(ValueError): retrieval_metrics([],[])
    def test_duplicates_rejected(self):
        with self.assertRaises(ValueError): retrieval_metrics(['a','a'],['a'])
    def test_document_ids_unique(self):
        with self.assertRaises(ValueError): Retriever([DATA['documents'][0]]*2)
    def test_current_filter_excludes_stale(self):
        hits=self.r.search('trial refund policy',current_only=True)
        self.assertTrue(hits)
        self.assertTrue(all(x['current'] for x in hits))
    def test_empty_query_abstains(self): self.assertEqual(self.r.search(''),[])
    def test_unknown_query_abstains(self): self.assertEqual(self.r.search('zzzzzz'),[])
    def test_no_k_inflation(self): self.assertLessEqual(len(self.r.search('refund trial',k=1)),1)

class AgentTests(unittest.TestCase):
    def setUp(self): self.r=Retriever(DATA['documents'])
    def test_scripted_contract_cases(self):
        for case in DATA['agent_cases']:
            with self.subTest(case=case['id']):
                if case['expected']=='finished':
                    r=run_agent(case['steps'],self.r,case.get('budget',4))
                    self.assertEqual(r['tool_calls'],2)
                    self.assertEqual([t['action'] for t in r['trace']],['search','read','finish'])
                else:
                    with self.assertRaises(AgentError): run_agent(case['steps'],self.r,case.get('budget',4))
    def test_document_injection_does_not_expand_tools(self):
        with self.assertRaisesRegex(AgentError,'allowlisted'):
            run_agent([{'action':'read','args':{'id':'injection'}},{'action':'delete_account'}],self.r)
    def test_arguments_are_typed(self):
        with self.assertRaises(AgentError): run_agent([{'action':'read','args':[]}],self.r)
    def test_citation_unknown_type(self):
        with self.assertRaises(AgentError): run_agent([{'action':'finish','args':{'answer':'a','citations':[{}]}}],self.r)

class GrowthTests(unittest.TestCase):
    def test_assignment_stable(self): self.assertEqual(allocation('u1','e1'),allocation('u1','e1'))
    def test_both_arms_present(self): self.assertEqual({allocation(str(i),'e1') for i in range(100)},{'A','B'})
    def test_positive_result_with_refund_caution(self):
        r=experiment(2000,200,2000,260,10,20)
        self.assertAlmostEqual(r['difference'],.03)
        self.assertLess(r['p_value'],.05)
        self.assertGreater(r['difference_ci95'][0],0)
        self.assertGreater(r['b_refund_rate'],r['a_refund_rate'])
    def test_srm_blocks_interpretation(self): self.assertEqual(experiment(2400,240,1600,208)['status'],'allocation_mismatch')
    def test_sparse_counts_not_normal_approval(self): self.assertEqual(experiment(2000,1,2000,2)['status'],'insufficient_counts')
    def test_identical_groups(self):
        r=experiment(100,10,100,10)
        self.assertEqual(r['p_value'],1)
        self.assertLess(r['difference_ci95'][0],0)
        self.assertGreater(r['difference_ci95'][1],0)
    def test_invalid_counts(self):
        for args in [(10,1,100,1),(100,101,100,1),(100,10,100,10,11,0)]:
            with self.assertRaises(ValueError): experiment(*args)
    def test_wilson_boundaries(self):
        self.assertGreaterEqual(wilson(0,100)[0],0)
        self.assertLessEqual(wilson(100,100)[1],1)
    def test_strict_funnel(self):
        rows=[{'event_id':str(i),'user':'u','session':'s','order_id':'o','type':t,'time':i+1} for i,t in enumerate(['exposure','plan','order','paid'])]
        self.assertEqual(len(strict_funnel(rows+[rows[-1]],0)),1)
        reverse=[dict(r,time=5-r['time']) for r in rows]
        self.assertEqual(strict_funnel(reverse,0),[])
        mismatch=[dict(r,order_id='wrong') if r['type']=='paid' else r for r in rows]
        self.assertEqual(strict_funnel(mismatch,0),[])
        self.assertEqual(strict_funnel(rows,7*86400),[])
    def test_cross_session_not_counted(self):
        rows=[{'event_id':str(i),'user':'u','session':str(i),'order_id':'o','type':t,'time':i+1} for i,t in enumerate(['exposure','plan','order','paid'])]
        self.assertEqual(strict_funnel(rows,0),[])

if __name__=='__main__': unittest.main(verbosity=2)
