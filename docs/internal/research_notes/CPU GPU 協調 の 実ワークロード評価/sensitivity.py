#!/usr/bin/env python3
"""Deterministic illustrations, NOT Metal or M5 measurements.

Run: python3 sensitivity.py > sensitivity.csv
All hypothetical crossing costs are non-overlapped incremental round trips.
"""

import csv
import math
import sys


def evaluate(cpu_ms, offload_fraction, region_speedup, overhead_ms):
    """Fixed work; C and W/G plus H are disjoint critical-path intervals."""
    assert cpu_ms > 0 and 0 <= offload_fraction <= 1
    assert region_speedup > 0 and overhead_ms >= 0
    residual = cpu_ms * (1 - offload_fraction)
    gpu = cpu_ms * offload_fraction / region_speedup
    total = residual + gpu + overhead_ms
    bound_denominator = residual + overhead_ms
    upper = math.inf if bound_denominator == 0 else cpu_ms / bound_denominator
    return total, cpu_ms / total, upper


def rows():
    # Fixed-work sensitivity: all crossing counts and costs are assumptions.
    for crossing_us in (10, 50):
        for crossings in (1, 10, 100, 1000):
            overhead = crossings * crossing_us / 1000
            yield ("100ms_sensitivity", 100, .95, 20, crossings,
                   crossing_us, overhead)
    # Same pure useful work, very different host-feedback depth.
    for crossings in (1, 200):
        yield ("10ms_feedback_depth", 10, .98, 20, crossings,
               50, crossings * .05)
    # Fractions are of the original CPU run, NOT of the GPU execution.
    for fraction in (.5, .8, .95, .99):
        yield ("serial_fraction", 10, fraction, 20, "", "", .1)


def main():
    # Algebraic consistency, boundary cases, and a feedback failure example.
    assert evaluate(10, .5, 1, 0)[1] == 1
    assert math.isclose(evaluate(10, .98, 20, 10)[0], 10.69)
    assert evaluate(10, .98, 20, 10)[2] < 1
    assert math.isclose(evaluate(100, .95, 20, .05)[1], 100 / 9.8)
    for _, t0, p, s, _, _, h in rows():
        total, speedup, upper = evaluate(t0, p, s, h)
        assert math.isclose(speedup, 1 / (1 - p + p / s + h / t0))
        assert (total < t0) == (h < t0 * p * (1 - 1 / s))
        assert speedup <= upper

    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(("scenario_all_values_hypothetical", "T0_ms", "p", "s",
                     "mandatory_host_feedback_rounds", "crossing_us",
                     "H_ms", "H_fraction_of_T0", "hybrid_ms", "speedup",
                     "speedup_upper_bound_s_infinite"))
    for label, t0, p, s, count, crossing, h in rows():
        total, speedup, upper = evaluate(t0, p, s, h)
        writer.writerow((label, t0, p, s, count, crossing, f"{h:.6f}",
                         f"{h / t0:.6f}", f"{total:.6f}",
                         f"{speedup:.6f}", f"{upper:.6f}"))


if __name__ == "__main__":
    main()
