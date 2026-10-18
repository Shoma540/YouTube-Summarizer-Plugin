# -*- coding: utf-8 -*-
"""
Obsidian YouTube Summarizer - article fetcher
Usage:
  python article_fetcher.py <url>            # full article fetch
  python article_fetcher.py --meta-only <url>  # meta only (title, siteName); text=""

Success: prints JSON {"title": "...", "siteName": "...", "text": "..."} to stdout, exit 0
Failure: prints "ERROR: <message>" to stderr, exit 1
"""
import sys
import json

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def err(msg):
    sys.stderr.write(f"ERROR: {msg}\n")
    sys.exit(1)


def extract_site_name(soup):
    og = soup.find("meta", attrs={"property": "og:site_name"})
    if og and og.get("content"):
        v = og.get("content").strip()
        if v:
            return v

    app = soup.find("meta", attrs={"name": "application-name"})
    if app and app.get("content"):
        v = app.get("content").strip()
        if v:
            return v

    if soup.title and soup.title.string:
        title = soup.title.string.strip()
        for sep in ["｜", "/", "-", "–", "—"]:
            if sep in title:
                parts = [p.strip() for p in title.split(sep) if p.strip()]
                if not parts:
                    continue
                # サイト名は記事タイトルより短いことが多いため、先頭・末尾のトークンのうち短い方を採用する
                # (「サイト名｜記事タイトル」「記事タイトル｜サイト名」どちらの並びにも対応するため)
                first, last = parts[0], parts[-1]
                return first if len(first) <= len(last) else last
    return ""


def main():
    args = sys.argv[1:]
    meta_only = False
    if "--meta-only" in args:
        meta_only = True
        args = [a for a in args if a != "--meta-only"]
    if len(args) < 1:
        err("URLが指定されていません")

    url = args[0]

    try:
        import requests
        from bs4 import BeautifulSoup
    except ImportError as e:
        missing = getattr(e, "name", "requests/beautifulsoup4")
        err(f"必要なライブラリ ({missing}) がインストールされていません。"
            "ターミナルで `pip install requests beautifulsoup4` を実行してください。")

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "ja,en;q=0.9",
    }

    try:
        resp = requests.get(url, headers=headers, timeout=10)
    except requests.Timeout:
        err("タイムアウトしました（10秒）")
    except requests.RequestException as e:
        err(f"リクエスト失敗: {e}")

    if resp.status_code >= 400:
        err(f"HTTPエラー {resp.status_code}")

    try:
        if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
            resp.encoding = resp.apparent_encoding or "utf-8"
    except Exception:
        pass

    html = resp.text

    soup = BeautifulSoup(html, "html.parser")

    title = ""
    if soup.title and soup.title.string:
        title = soup.title.string.strip()

    site_name = extract_site_name(soup)

    if meta_only:
        result = {"title": title, "siteName": site_name, "text": ""}
        print(json.dumps(result, ensure_ascii=True))
        sys.exit(0)

    def get_text(node):
        return node.get_text("\n", strip=True)

    text = ""
    article = soup.find("article")
    if article:
        text = get_text(article)
    else:
        main_el = soup.find("main")
        if main_el:
            text = get_text(main_el)
        else:
            body = soup.find("body")
            if body:
                for tag in body.find_all(["script", "style", "nav", "header", "footer"]):
                    tag.decompose()
                text = get_text(body)

    if not text or len(text) < 500:
        err("本文を取得できませんでした（JSレンダリング非対応）")

    result = {"title": title, "siteName": site_name, "text": text}
    print(json.dumps(result, ensure_ascii=True))
    sys.exit(0)


if __name__ == "__main__":
    main()
