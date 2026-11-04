"""Shared package-version contract for archive construction and promotion."""

import re


SEMVER = re.compile(
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)"
    r"(?:-(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


def validate_package_version(value: str) -> None:
    if not isinstance(value, str) or SEMVER.fullmatch(value) is None:
        raise ValueError("package version must be a valid XenoPi semantic version")
    core = value.split("+", 1)[0].split("-", 1)[0]
    if any(int(part) > 2**64 - 1 for part in core.split(".")):
        raise ValueError("package version numeric components exceed the supported range")
    prerelease = value.split("+", 1)[0].partition("-")[2]
    if any(part.isdigit() and len(part) > 1 and part.startswith("0") for part in prerelease.split(".")):
        raise ValueError("numeric prerelease identifiers must not have leading zeroes")
