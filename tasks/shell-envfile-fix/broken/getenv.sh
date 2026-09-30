#!/bin/sh
set -eu
file=$1
key=$2
line=$(grep "${key}=" "$file") || exit 1
line=$(printf '%s\n' "$line" | tail -n 1)
value=${line#*=}
case $value in
  \"*\") value=${value#\"}; value=${value%\"} ;;
esac
printf '%s\n' "$value"
