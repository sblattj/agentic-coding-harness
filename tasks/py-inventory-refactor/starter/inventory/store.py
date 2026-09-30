class Store:
    def __init__(self):
        self.items = {}

    def add(self, name, price, qty):
        self.items[name] = {"price": price, "qty": qty}

    def calc(self):
        total = 0
        for item in self.items.values():
            total += item["price"] * item["qty"]
        return total
