def summary(store):
    total = 0
    for name, item in store.items.items():
        total += item["price"] * item["qty"]
    return f"{len(store.items)} items, total {total:.2f}"
