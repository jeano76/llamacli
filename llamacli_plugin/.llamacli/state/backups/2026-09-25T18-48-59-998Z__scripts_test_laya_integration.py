"""Unit tests for laya_integration helpers (no network access required)."""
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, os.path.dirname(HERE))  # parent of scripts/ -> importable module dir

import laya_integration as L  # type: ignore


class DecisionFromAnswerTests(unittest.TestCase):
    def test_choice_affirming(self):
        val = {
            "type": "choice",
            "choice": "yes",
            "probabilities": {"yes": 0.92, "no": 0.08},
            "confidence": 0.6,
            "answer_confidence": 0.61,
        }
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(label, "yes")
        self.assertAlmostEqual(score, max(0.92, 0.08), places=3)
        self.assertEqual(decision, "yes")

    def test_choice_non_affirming(self):
        val = {
            "type": "choice",
            "choice": "no",
            "probabilities": {"yes": 0.10, "no": 0.90},
            "confidence": 0.7,
        }
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(label, "no")
        self.assertAlmostEqual(score, max(0.10, 0.90), places=3)
        self.assertEqual(decision, "no")

    def test_noul_high_confidence_yes(self):
        val = {"type": "noul", "noul": 0.95, "confidence": 0.5}
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(label, "yes")
        self.assertAlmostEqual(score, max(0.95, 0.05), places=3)
        self.assertEqual(decision, "yes")

    def test_noul_low_confidence_no(self):
        val = {"type": "noul", "noul": 0.10}
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(label, "no")
        self.assertEqual(decision, "no")

    def test_score_in_range(self):
        val = {"type": "score", "score": 0.30, "legend": ["low", "high"]}
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(label, "0.300")
        self.assertAlmostEqual(score, 0.30, places=3)
        self.assertEqual(decision, "n/a")

    def test_score_out_of_range_clamped(self):
        # Live server returned 1.6398 for risk (out of [0,1]); must not crash.
        val = {"type": "score", "score": 1.6398}
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(score, 0.5)   # neutral fallback for out-of-range input
        self.assertEqual(decision, "n/a")

    def test_score_out_of_range_low(self):
        val = {"type": "score", "score": -2.0}
        _, score, _ = L._decision_from_answer(val)
        self.assertEqual(score, 0.5)

    def test_unknown_kind_returns_fallback(self):
        val = {"type": "typed-decisions", "data": [1, 2, 3]}
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(score, 0.0)
        self.assertEqual(decision, "n/a")
        self.assertIn("typed-decisions", label)

    def test_non_dict_returns_fallback(self):
        label, score, decision = L._decision_from_answer("oops")
        self.assertEqual(score, 0.0)
        self.assertEqual(decision, "n/a")

    def test_no_matching_kind_key_returns_fallback(self):
        # A dict with none of choice/noul/score keys must not reach the final return.
        val = {"type": "choice", "choice_key_missing_here": True}
        label, score, decision = L._decision_from_answer(val)
        self.assertEqual(score, 0.0)
        self.assertEqual(decision, "n/a")


class MakeAgentTraceQuestionTests(unittest.TestCase):
    def test_five_separate_questions(self):
        q = L._make_agent_trace_question("tool instructions here")
        # Five independent top-level question keys, not a single wrapped blob.
        self.assertEqual(
            set(q.keys()), {"action", "outcome", "risk", "needs_review", "urgency"}
        )

    def test_action_is_choice_with_criteria(self):
        q = L._make_agent_trace_question("instr")
        self.assertEqual(q["action"]["type"], "choice")
        self.assertIn("criteria", q["action"])
        # action workflow labels: read/write/execute/delete/network
        for k in ("read", "write", "execute", "delete", "network"):
            self.assertIn(k, q["action"]["criteria"])

    def test_outcome_is_choice(self):
        q = L._make_agent_trace_question("instr")
        self.assertEqual(q["outcome"]["type"], "choice")

    def test_risk_is_score(self):
        q = L._make_agent_trace_question("instr")
        self.assertEqual(q["risk"]["type"], "score")
        self.assertIsInstance(q["risk"].get("criteria"), list)

    def test_needs_review_is_noul(self):
        q = L._make_agent_trace_question("instr")
        self.assertEqual(q["needs_review"]["type"], "noul")
        self.assertNotIn("criteria", q["needs_review"])

    def test_urgency_is_noul(self):
        q = L._make_agent_trace_question("instr")
        self.assertEqual(q["urgency"]["type"], "noul")

    def test_instructions_threaded_through(self):
        q = L._make_agent_trace_question("MY INSTR")
        for key in ("action", "outcome", "risk", "needs_review", "urgency"):
            self.assertEqual(q[key]["instructions"], "MY INSTR")


class DecisionFromAgentTraceTests(unittest.TestCase):
    def _payload(self):
        return {
            "answers": {
                "action": {"type": "choice", "choice": "yes",
                           "probabilities": {"yes": 0.9, "no": 0.1},
                           "confidence": 0.6, "answer_confidence": 0.62},
                "outcome": {"type": "choice", "choice": "success",
                            "probabilities": {"success": 0.8, "failure": 0.2},
                            "confidence": 0.5},
                "risk": {"type": "score", "score": 1.6398,
                         "legend": ["low", "high"], "probabilities": {}, "confidence": 0.4},
                "needs_review": {"type": "noul", "noul": 0.05,
                                 "confidence": 0.3, "answer_confidence": 0.31},
                "urgency": {"type": "noul", "noul": 0.1,
                            "confidence": 0.3, "answer_confidence": 0.28},
            }
        }

    def test_renders_all_fields(self):
        out = L._decision_from_agent_trace(self._payload())
        self.assertIsNotNone(out)
        self.assertIn("action", out)
        self.assertIn("outcome", out)
        self.assertIn("risk", out)
        self.assertIn("needs_review", out)
        self.assertIn("urgency", out)

    def test_score_out_of_range_does_not_crash(self):
        # The exact live payload that used to raise UnboundLocalError.
        out = L._decision_from_agent_trace(self._payload())
        self.assertEqual(out.count("\n"), 4)  # action + 4 sub-lines

    def test_empty_answers_returns_none(self):
        self.assertIsNone(L._decision_from_agent_trace({"answers": {}}))


class ResourceGateTests(unittest.TestCase):
    """resource_gate_ok(): only block when BOTH RAM and swap are short."""

    def _cfg(self, min_swap_kb=2_000_000, min_ram_kb=1_000_000):
        return {"minSwapKb": min_swap_kb, "minRamKb": min_ram_kb}

    def gate_with(self, free_swap_bytes, free_ram_bytes):
        return (
            mock.patch.object(L, "swap_free_bytes", lambda: free_swap_bytes),
            mock.patch.object(L, "ram_free_bytes", lambda: free_ram_bytes),
        )

    def test_both_sufficient_passes(self):
        p_swap, p_ram = self.gate_with(5_000_000 * 1024, 5_000_000 * 1024)
        with p_swap, p_ram:
            ok, reason = L.resource_gate_ok(self._cfg())
        self.assertTrue(ok, reason)

    def test_ram_short_swap_sufficient_blocks(self):
        # RAM shortage alone is always dangerous -> block.
        p_swap, p_ram = self.gate_with(5_000_000 * 1024, 500 * 1024)
        with p_swap, p_ram:
            ok, reason = L.resource_gate_ok(self._cfg())
        self.assertFalse(ok, "expected block")
        self.assertIn("RAM", reason)

    def test_swap_short_ram_sufficient_passes_now(self):
        # The case the gate used to wrongly skip on this machine.
        p_swap, p_ram = self.gate_with(188, 12_000_000 * 1024)
        with p_swap, p_ram:
            ok, reason = L.resource_gate_ok(self._cfg())
        self.assertTrue(ok, f"expected pass, got {reason}")

    def test_both_short_blocks(self):
        p_swap, p_ram = self.gate_with(188, 500 * 1024)
        with p_swap, p_ram:
            ok, reason = L.resource_gate_ok(self._cfg())
        self.assertFalse(ok, "expected block")
        self.assertIn("both", reason.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
