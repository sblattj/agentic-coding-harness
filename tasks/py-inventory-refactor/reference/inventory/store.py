import warnings


class Store:
    def __init__(self):
        self.items = {}

    def add(self, name, price, qty):
        self.items[name] = {"price": price, "qty": qty}

    def total_value(self):
        return sum(item["price"] * item["qty"] for item in self.items.values())

    def calc(self):
        warnings.warn("Store.calc() is deprecated; use Store.total_value()", DeprecationWarning, stacklevel=2)
        return self.total_value()
