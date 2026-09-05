#!/usr/bin/env bash

# Publish an existing draft release without overwriting a manually authored body.
set -euo pipefail

repo="${1:?usage: publish-github-release.sh OWNER/REPO TAG}"
tag="${2:?usage: publish-github-release.sh OWNER/REPO TAG}"

# The REST tag endpoint only finds published releases. `release view` also
# resolves drafts, including the draft populated by the platform build jobs.
release="$(gh release view "${tag}" --repo "${repo}" \
  --json databaseId,isDraft,body --jq '{id: .databaseId, draft: .isDraft, body}')"
release_id="$(jq -er '.id' <<<"${release}")"
release_is_draft="$(jq -r '.draft == true' <<<"${release}")"

work_dir="$(mktemp -d)"
trap 'rm -rf "${work_dir}"' EXIT
update_file="${work_dir}/release-update.json"

if [[ "${release_is_draft}" == "true" ]] && jq -e '(.body // "") | type == "string" and test("^[[:space:]]*$")' <<<"${release}" >/dev/null; then
  notes_file="${work_dir}/generated-notes.json"
  gh api "repos/${repo}/releases/generate-notes" -X POST -f "tag_name=${tag}" >"${notes_file}"
  jq -e '(.body | type == "string") and (.body | test("\\S"))' "${notes_file}" >/dev/null
  jq '{ body, draft: false, make_latest: true }' "${notes_file}" >"${update_file}"
else
  jq -n '{ draft: false, make_latest: true }' >"${update_file}"
fi

gh api "repos/${repo}/releases/${release_id}" -X PATCH --input "${update_file}"
