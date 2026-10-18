"""One declared capacity scale for the RPC driver and its public evidence."""
DEFAULT_PROVISIONAL_RATE = 64
STEP_SECONDS = 300
STEP_PERCENTAGES = (25,50,75,100)


def offered_rates(provisional):
    if type(provisional) is not int or not 4<=provisional<=64:
        raise ValueError('Ledger provisional capacity must be an integer in4..64')
    return [max(1, provisional*percent//100) for percent in STEP_PERCENTAGES]
