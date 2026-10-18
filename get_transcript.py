# -*- coding: utf-8 -*-
"""
Obsidian YouTube Summarizer - transcript fetcher
Usage:
  python get_transcript.py <videoId>
    -> {"transcript": "...", "conflict_note": "...", "has_manual": bool,
        "publish_date": "...", "title": "...", "description": "...", "channel_name": "..."}  exit 0
  python get_transcript.py --meta-only <videoId>
    -> {"title": "...", "channel_name": "...", "description": "...",
        "transcript": "", "conflict_note": "", "has_manual": false, "publish_date": "..."}  exit 0
  failure: {"error": "...", "code": "..."}  exit 1
"""
import sys
import json
import re
import os
from urllib.parse import urlparse, parse_qs

DATA_FILE = os.path.join(os.path.dirname(__file__), "data.json")


def load_proxy_config():
    """data.jsonからWebshareプロキシ設定を読み込む（youtube-transcript-api用）。なければNoneを返す。"""
    try:
        from youtube_transcript_api.proxies import WebshareProxyConfig
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        proxy = data.get('proxyConfig', {})
        username = proxy.get('username', '').strip()
        password = proxy.get('password', '').strip()
        if username and password:
            return WebshareProxyConfig(
                proxy_username=username,
                proxy_password=password,
                retries_when_blocked=10,
            )
        return None
    except Exception:
        return None


def load_requests_proxies():
    """data.jsonからWebshareプロキシ設定をrequests用辞書で返す。なければNoneを返す。"""
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        proxy = data.get('proxyConfig', {})
        username = proxy.get('username', '').strip()
        password = proxy.get('password', '').strip()
        if username and password:
            proxy_url = f"http://{username}:{password}@p.webshare.io:80"
            return {"http": proxy_url, "https": proxy_url}
        return None
    except Exception:
        return None


def _err(message: str, code: str) -> None:
    print(json.dumps({"error": message, "code": code}, ensure_ascii=True), file=sys.stderr)
    sys.exit(1)


def extract_video_id(url_or_id: str) -> str:
    """URLまたはビデオIDを受け取り、ビデオIDのみを返す"""
    if re.match(r'^[a-zA-Z0-9_-]{11}$', url_or_id):
        return url_or_id
    match = re.search(r'youtu\.be/([a-zA-Z0-9_-]{11})', url_or_id)
    if match:
        return match.group(1)
    parsed = urlparse(url_or_id)
    qs = parse_qs(parsed.query)
    if 'v' in qs:
        return qs['v'][0]
    return url_or_id


def fetch_video_meta(video_id: str, proxies=None) -> dict:
    """YouTubeページからタイトル・概要欄・チャンネル名・公開日をプロキシ経由で取得する。"""
    import requests as _req
    url = f"https://www.youtube.com/watch?v={video_id}"
    headers = {
        "Accept-Language": "ja,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    try:
        resp = _req.get(url, headers=headers, proxies=proxies, timeout=15)
        html = resp.text
    except Exception:
        return {"title": "", "description": "", "channel_name": "", "publish_date": "動画公開日不明"}

    # title
    title_m = re.search(r'<title>([^<]+)</title>', html)
    title = title_m.group(1).replace(" - YouTube", "").strip() if title_m else ""

    # description
    desc_m = re.search(r'"shortDescription":"((?:[^"\\]|\\.)*)"', html)
    description = ""
    if desc_m:
        description = desc_m.group(1).replace("\\n", "\n").replace('\\"', '"')[:1500].strip()

    # channel_name
    channel_name = ""
    for pattern in [
        r'"ownerChannelName":"([^"]+)"',
        r'"author":"([^"]+)"',
        r'"channelName":"([^"]+)"',
    ]:
        m = re.search(pattern, html)
        if m:
            channel_name = m.group(1).strip()
            break

    # publish_date (JSON-LD優先、次にmeta itemprop)
    publish_date = "動画公開日不明"
    for m in re.finditer(
        r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
        html,
        re.DOTALL,
    ):
        try:
            ld = json.loads(m.group(1))
        except Exception:
            continue
        items = ld if isinstance(ld, list) else [ld]
        for item in items:
            if isinstance(item, dict) and item.get("datePublished"):
                m2 = re.match(r"(\d{4}-\d{2}-\d{2})", str(item["datePublished"]))
                if m2:
                    publish_date = m2.group(1)
                    break
        if publish_date != "動画公開日不明":
            break
    if publish_date == "動画公開日不明":
        meta_m = re.search(r'<meta\s+itemprop="datePublished"\s+content="([^"]+)"', html)
        if meta_m:
            m2 = re.match(r"(\d{4}-\d{2}-\d{2})", meta_m.group(1))
            if m2:
                publish_date = m2.group(1)

    return {"title": title, "description": description, "channel_name": channel_name, "publish_date": publish_date}


def main():
    args = sys.argv[1:]
    meta_only = False
    if args and args[0] == "--meta-only":
        meta_only = True
        args = args[1:]

    if not args:
        print(json.dumps({"error": "videoId required"}))
        sys.exit(1)

    video_id = extract_video_id(args[0])
    proxies = load_requests_proxies()

    if meta_only:
        meta = fetch_video_meta(video_id, proxies=proxies)
        result = {
            "title": meta.get("title", ""),
            "channel_name": meta.get("channel_name", ""),
            "description": meta.get("description", ""),
            "transcript": "",
            "conflict_note": "",
            "has_manual": False,
            "publish_date": meta.get("publish_date", "動画公開日不明"),
        }
        print(json.dumps(result, ensure_ascii=True))
        sys.exit(0)

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        _err(
            "youtube-transcript-api がインストールされていません。"
            "ターミナルで `python -m pip install youtube-transcript-api` を実行してください。",
            "UNKNOWN_ERROR",
        )

    try:
        from youtube_transcript_api._errors import (
            VideoUnavailable,
            TranscriptsDisabled,
            NoTranscriptFound,
            IpBlocked,
        )
    except ImportError:
        _err(
            "youtube-transcript-api のバージョンが古い可能性があります。"
            "ターミナルで `python -m pip install --upgrade youtube-transcript-api` を実行してください。",
            "UNKNOWN_ERROR",
        )

    proxy_config = load_proxy_config()
    try:
        if proxy_config:
            api = YouTubeTranscriptApi(proxy_config=proxy_config)
        else:
            api = YouTubeTranscriptApi()
        transcript_list = api.list(video_id)

        manual_data = None
        auto_data = None
        has_manual = False

        try:
            manual = transcript_list.find_manually_created_transcript(["ja", "en"])
            manual_data = list(manual.fetch())
            has_manual = True
            try:
                auto_t = transcript_list.find_generated_transcript(["ja", "en"])
                auto_data = list(auto_t.fetch())
            except Exception:
                auto_data = None
        except Exception:
            try:
                auto_t = transcript_list.find_generated_transcript(["ja", "en"])
                manual_data = list(auto_t.fetch())
            except Exception:
                first_t = next(iter(transcript_list))
                manual_data = list(first_t.fetch())

        def is_low_confidence(seg):
            text = (seg.text or "").strip()
            duration = getattr(seg, "duration", 0) or 0
            if duration < 0.5:
                return True
            if len(text) <= 1:
                return True
            return False

        segments = []
        for seg in manual_data:
            text = (seg.text or "").strip()
            if not text:
                continue
            if is_low_confidence(seg):
                text = f"[⚠️不確か:{text}]"
            segments.append(text)

        conflicts = []
        if has_manual and auto_data:
            auto_dict = {}
            for s in auto_data:
                k = round(s.start, 0)
                auto_dict[k] = (s.text or "").strip()
            for s in manual_data:
                k = round(s.start, 0)
                if k not in auto_dict:
                    continue
                m_text = (s.text or "").strip()
                a_text = auto_dict[k]
                m_nums = set(re.findall(r"\d+\.?\d*", m_text))
                a_nums = set(re.findall(r"\d+\.?\d*", a_text))
                if m_nums != a_nums and (m_nums or a_nums):
                    conflicts.append(f"[⚠️数字矛盾 手動:{m_text} 自動:{a_text}]")

        text = " ".join(segments)
        text = " ".join(text.split())

        if not text:
            _err("字幕は存在するが本文が空でした", "NO_TRANSCRIPT")

        meta = fetch_video_meta(video_id, proxies=proxies)

        result = {
            "transcript": text,
            "conflict_note": "\n".join(conflicts),
            "has_manual": has_manual,
            "publish_date": meta.get("publish_date", "動画公開日不明"),
            "title": meta.get("title", ""),
            "description": meta.get("description", ""),
            "channel_name": meta.get("channel_name", ""),
        }
        print(json.dumps(result, ensure_ascii=True))
        sys.exit(0)
    except IpBlocked:
        _err("YouTubeにIPブロックされています。Webshareプロキシ設定を確認してください", "IP_BLOCKED")
    except TranscriptsDisabled:
        _err("この動画は字幕が無効になっています", "TRANSCRIPTS_DISABLED")
    except NoTranscriptFound:
        _err("この動画には字幕がありません", "NO_TRANSCRIPT")
    except VideoUnavailable:
        _err("動画にアクセスできません（非公開・削除・地域制限の可能性）", "VIDEO_UNAVAILABLE")
    except Exception as e:
        msg = str(e)
        if "InvalidVideoId" in type(e).__name__ or "InvalidVideoId" in msg:
            _err("無効な動画URLです", "INVALID_VIDEO_ID")
        elif "network" in msg.lower() or "connection" in msg.lower() or "timeout" in msg.lower():
            _err("ネットワークエラーが発生しました", "NETWORK_ERROR")
        else:
            _err(f"不明なエラーが発生しました: {msg[:100]}", "UNKNOWN_ERROR")


if __name__ == "__main__":
    main()
