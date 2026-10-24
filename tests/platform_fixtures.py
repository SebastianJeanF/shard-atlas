"""Real filesystem fixtures with explicit skips for unavailable OS capabilities."""


def symlink_or_skip(test, link, target):
    try:
        link.symlink_to(target)
    except OSError as error:
        if getattr(error, "winerror", None) == 1314:
            test.skipTest("Creating symlinks requires an unavailable Windows privilege.")
        raise
