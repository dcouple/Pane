from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

from .releases import ResolvedRelease, artifact_file_name


@dataclass
class DownloadedArtifact:
    path: str
    file_name: str
    used_fallback: bool


def download_artifact(resolved: ResolvedRelease, download_dir: Optional[str], verbose: bool) -> DownloadedArtifact:
    target_dir = download_dir or os.path.join(tempfile.gettempdir(), f"runpane-{int(time.time() * 1000)}")
    os.makedirs(target_dir, exist_ok=True)

    file_name = artifact_file_name(resolved.artifact["name"])
    target_path = os.path.join(target_dir, file_name)
    used_fallback = False

    try:
        download_to_file(resolved.preferred_download_url, target_path, verbose)
    except Exception as error:
        used_fallback = True
        print(f"runpane: website download route failed; falling back to GitHub release asset. {error}")
        download_to_file(resolved.fallback_download_url, target_path, verbose)

    verify_checksum_if_available(resolved, target_path, file_name)
    return DownloadedArtifact(path=target_path, file_name=file_name, used_fallback=used_fallback)


def download_to_file(url: str, target_path: str, verbose: bool) -> None:
    if verbose:
        print(f"Downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "runpane-installer"})
    with urllib.request.urlopen(req, timeout=120) as response:
        if getattr(response, "status", 200) >= 400:
            raise RuntimeError(f"{response.status} {response.reason}")
        with open(target_path, "wb") as target:
            shutil.copyfileobj(response, target, length=1024 * 1024)


def verify_checksum_if_available(resolved: ResolvedRelease, artifact_path: str, file_name: str) -> None:
    try:
        req = urllib.request.Request(resolved.checksum_url, headers={"User-Agent": "runpane-installer"})
        with urllib.request.urlopen(req, timeout=30) as response:
            checksums = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print(f"runpane: could not verify checksum for {file_name}. {error}")
        return

    expected = parse_checksum(checksums, file_name)
    if not expected:
        return

    digest = hashlib.sha256()
    with open(artifact_path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)

    actual = digest.hexdigest()
    if actual.lower() != expected.lower():
        raise RuntimeError(f"Checksum mismatch for {file_name}. Expected {expected}, got {actual}.")


def parse_checksum(checksums: str, file_name: str) -> Optional[str]:
    for line in checksums.splitlines():
        stripped = line.strip()
        if not stripped.endswith(file_name):
            continue
        digest = stripped.split()[0]
        if len(digest) == 64 and all(char in "0123456789abcdefABCDEF" for char in digest):
            return digest
    return None
