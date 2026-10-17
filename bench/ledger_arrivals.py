"""Count live ledger owners at the scheduled arrival, after pacing waits."""


def collect_ready(in_flight, counts, success_latencies):
    for future in list(in_flight):
        if not future.done():
            continue
        outcome, acknowledged, latency = future.result()
        counts[outcome] += 1
        counts['acknowledged'] += acknowledged
        if acknowledged:
            success_latencies.append(latency)
        in_flight.remove(future)


def has_capacity(in_flight, counts, success_latencies, maximum=8):
    if type(maximum) is not int or maximum <= 0:
        raise ValueError('Invalid ledger concurrency limit')
    # Requests can complete while the scheduler sleeps. Completed futures are
    # accounting receipts, not live work that may cause a dropped arrival.
    collect_ready(in_flight, counts, success_latencies)
    return len(in_flight) < maximum
