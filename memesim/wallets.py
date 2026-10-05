"""Simulated paper wallets. Names are labels, not addresses or keys."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Wallet:
    name: str
    role: str  # "creator", "sniper", "retail", "bot"
    base: float
    tokens: float = 0.0
    base_spent: float = 0.0
    base_received: float = 0.0
    starting_base: float = 0.0

    def __post_init__(self) -> None:
        self.starting_base = self.base

    def value(self, price: float) -> float:
        return self.base + self.tokens * price

    def pnl(self, price: float) -> float:
        return self.value(price) - self.starting_base
