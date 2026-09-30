import re


def slugify(text, max_length=None):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if max_length is not None and len(slug) > max_length:
        cut = slug[:max_length]
        if slug[max_length] != "-" and "-" in cut:
            cut = cut[: cut.rindex("-")]
        slug = cut.rstrip("-")
    return slug
