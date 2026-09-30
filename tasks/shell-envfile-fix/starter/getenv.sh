#!/bin/sh
file=$1
key=$2
line=$(grep "$key=" "$file" | head -n 1) || exit 1
printf '%s\n' "$line" | cut -d= -f2 | tr -d '"'
