# Fix rotate.sh

`rotate.sh DIR KEEP` deletes old `*.log` files in DIR (not recursively),
keeping the KEEP newest. Log names sort by date (`app-20260101.log`), so
"newest" means last in plain byte-wise name order.

The script has bugs: it keeps one file too few, and it breaks on file names
containing spaces. Fix it so that:

- exactly the KEEP last-sorting `*.log` files remain (all of them if there
  are KEEP or fewer);
- names with spaces work;
- files not ending in `.log` and subdirectories are never touched;
- an empty directory is not an error (exit 0).

Keep it POSIX sh.
