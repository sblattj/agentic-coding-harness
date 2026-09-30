def merge(intervals):
    pairs = []
    for start, end in intervals:
        if start > end:
            raise ValueError(f"interval ({start}, {end}) has start > end")
        pairs.append((start, end))
    pairs.sort()
    out = []
    for start, end in pairs:
        if out and start <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out
