import datetime
import sys
import time

import requests

BINANCE_BASE_URL = "https://api.binance.com/api/v3"
SYMBOLS = ["BTCUSDT", "ETHUSDT"]


def get_price(symbol: str) -> float:
    """获取币种当前价格"""
    try:
        resp = requests.get(
            f"{BINANCE_BASE_URL}/ticker/price",
            params={"symbol": symbol},
            timeout=5,
        )
        resp.raise_for_status()
        return float(resp.json()["price"])
    except Exception as e:
        print(f"获取 {symbol} 价格失败: {e}")
        return None


def main():
    """主函数"""
    # 默认实时循环，可以用 --once 参数只获取一次
    once = "--once" in sys.argv or "-o" in sys.argv
    
    try:
        while True:
            prices = {}
            for symbol in SYMBOLS:
                price = get_price(symbol)
                if price is not None:
                    prices[symbol] = price
            
            # 只输出纯数字价格
            if prices:
                if "BTCUSDT" in prices:
                    print(f"{prices['BTCUSDT']}")
                if "ETHUSDT" in prices:
                    print(f"{prices['ETHUSDT']}")
            
            if once:
                break
            
            time.sleep(1)  # 每秒更新一次
            
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()