"""Constant-product (x * y = k) AMM pool, Uniswap-v2 / Raydium style.

All amounts are plain floats in simulated units: `base` is the quote asset
(think SOL), `token` is the meme coin. Nothing here touches a real chain.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Pool:
    token_reserve: float
    base_reserve: float
    fee: float = 0.0025
    lp_supply: float = 0.0
    lp_balances: dict[str, float] = field(default_factory=dict)

    @property
    def price(self) -> float:
        """Spot price of one token, in base."""
        if self.token_reserve <= 0:
            return 0.0
        return self.base_reserve / self.token_reserve

    def quote_buy(self, base_in: float) -> float:
        base_after_fee = base_in * (1 - self.fee)
        k = self.token_reserve * self.base_reserve
        return self.token_reserve - k / (self.base_reserve + base_after_fee)

    def quote_sell(self, token_in: float) -> float:
        token_after_fee = token_in * (1 - self.fee)
        k = self.token_reserve * self.base_reserve
        return self.base_reserve - k / (self.token_reserve + token_after_fee)

    def buy(self, base_in: float) -> float:
        if base_in <= 0 or self.base_reserve <= 0:
            return 0.0
        tokens_out = self.quote_buy(base_in)
        self.base_reserve += base_in
        self.token_reserve -= tokens_out
        return tokens_out

    def sell(self, token_in: float) -> float:
        if token_in <= 0 or self.token_reserve <= 0:
            return 0.0
        base_out = self.quote_sell(token_in)
        self.token_reserve += token_in
        self.base_reserve -= base_out
        return base_out

    def add_liquidity(self, owner: str, token_amount: float, base_amount: float) -> float:
        if self.lp_supply == 0:
            minted = (token_amount * base_amount) ** 0.5
        else:
            minted = min(
                token_amount / self.token_reserve * self.lp_supply,
                base_amount / self.base_reserve * self.lp_supply,
            )
        self.token_reserve += token_amount
        self.base_reserve += base_amount
        self.lp_supply += minted
        self.lp_balances[owner] = self.lp_balances.get(owner, 0.0) + minted
        return minted

    def remove_liquidity(self, owner: str, fraction: float = 1.0) -> tuple[float, float]:
        """Burn `fraction` of owner's LP shares; returns (tokens, base) withdrawn."""
        shares = self.lp_balances.get(owner, 0.0) * fraction
        if shares <= 0 or self.lp_supply <= 0:
            return 0.0, 0.0
        share = shares / self.lp_supply
        tokens = self.token_reserve * share
        base = self.base_reserve * share
        self.token_reserve -= tokens
        self.base_reserve -= base
        self.lp_supply -= shares
        self.lp_balances[owner] -= shares
        return tokens, base
