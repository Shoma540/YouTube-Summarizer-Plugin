# -*- coding: utf-8 -*-
"""
get_playlist.py - プレイリスト or 単一動画URLから動画一覧を取得する
Usage:
  python get_playlist.py <url>
  stdout: 再生リストのときは先頭に
          {"playlistTitle": "...", "playlistCount": N,
           "membersOnlyCount": M, "unavailableCount": U}
          以降は1行1件JSON {"url": "...", "title": "..."}
  stderr: ERROR: ... (exit code 1)

playlistCount は再生リストが申告している総本数。実際に取得できた件数がこれを
下回る場合、yt-dlpがページングに失敗して途中までしか取れていない可能性がある
（2026-09: yt-dlp 2026.3.17 が100件で打ち切られる問題を検知するために追加）。

membersOnlyCount / unavailableCount は一覧の時点で処理対象から外した本数
（2026-09-20追加）。メンバー限定（availability="subscriber_only"）・非公開・
Premium限定の動画は字幕も動画本体も取得できず、清書側で3回リトライした末に
スキップされるだけなので、ここで除外して results には含めない。
availability が None（=バッジ無しの通常動画）のものは必ず残す。
"""
import os
import sys
import json
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# yt-dlp が返す availability のうち、取得しても清書できないもの
MEMBERS_ONLY_AVAILABILITY = "subscriber_only"
UNAVAILABLE_AVAILABILITY = ("private", "premium_only")


def ensure_ytdlp():
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "yt-dlp"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def get_playlist_info(url):
    import yt_dlp

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "ignoreerrors": True,
    }

    cookies_path = os.path.join(os.path.dirname(__file__), "cookies.txt")
    if os.path.exists(cookies_path):
        ydl_opts["cookiefile"] = cookies_path

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info is None:
            raise Exception("動画情報を取得できませんでした")

        entries = info.get("entries")
        if entries is not None:
            playlist_title = info.get("title") or ""
            playlist_count = info.get("playlist_count")
            results = []
            members_only_count = 0
            unavailable_count = 0
            for entry in entries:
                if entry is None:
                    continue
                availability = entry.get("availability")
                if availability == MEMBERS_ONLY_AVAILABILITY:
                    members_only_count += 1
                    continue
                if availability in UNAVAILABLE_AVAILABILITY:
                    unavailable_count += 1
                    continue
                video_id = entry.get("id", "")
                video_url = (
                    f"https://www.youtube.com/watch?v={video_id}"
                    if video_id
                    else entry.get("url", "")
                )
                if not video_url:
                    continue
                title = entry.get("title") or video_id
                results.append({"url": video_url, "title": title})
            return {
                "results": results,
                "playlistTitle": playlist_title,
                "playlistCount": playlist_count,
                "membersOnlyCount": members_only_count,
                "unavailableCount": unavailable_count,
            }
        else:
            video_id = info.get("id", "")
            video_url = (
                f"https://www.youtube.com/watch?v={video_id}"
                if video_id
                else url
            )
            title = info.get("title") or video_id
            return {
                "results": [{"url": video_url, "title": title}],
                "playlistTitle": "",
                "playlistCount": None,
                "membersOnlyCount": 0,
                "unavailableCount": 0,
            }


def main():
    if len(sys.argv) < 2:
        print("ERROR: URL required", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]

    try:
        ensure_ytdlp()
    except Exception as e:
        print(f"ERROR: yt-dlpのインストールに失敗しました: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        info = get_playlist_info(url)
        results = info["results"]
        playlist_title = info["playlistTitle"]
        playlist_count = info["playlistCount"]
        members_only_count = info["membersOnlyCount"]
        unavailable_count = info["unavailableCount"]
        has_count = isinstance(playlist_count, int) and playlist_count > 0
        has_excluded = members_only_count > 0 or unavailable_count > 0
        if playlist_title or has_count or has_excluded:
            meta = {"playlistTitle": playlist_title}
            if has_count:
                meta["playlistCount"] = playlist_count
            if members_only_count > 0:
                meta["membersOnlyCount"] = members_only_count
            if unavailable_count > 0:
                meta["unavailableCount"] = unavailable_count
            print(json.dumps(meta, ensure_ascii=False))
        for item in results:
            print(json.dumps(item, ensure_ascii=False))
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
