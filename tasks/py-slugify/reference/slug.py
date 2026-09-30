import re
import unicodedata


def slugify(text, max_length=None):
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")
    if max_length is not None and len(slug) > max_length:
        cut = slug[:max_length]
        if slug[max_length] != "-" and "-" in cut:
            cut = cut[: cut.rindex("-")]
        slug = cut.rstrip("-")
    return slug
