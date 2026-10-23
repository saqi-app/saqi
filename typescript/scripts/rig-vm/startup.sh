#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git tmux python3 xz-utils unattended-upgrades
if ! id saqi >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash saqi
fi
install -d -m 0700 -o saqi -g saqi /home/saqi/.codex /home/saqi/.config/saqi /home/saqi/.local/state/saqi/results /home/saqi/.local/state/saqi/results-standard
install -d -m 0755 -o saqi -g saqi /home/saqi/work
if ! test -x /opt/node-v26.12.1-linux-x64/bin/node; then
  task_dir=$(mktemp -d)
  trap 'rm -rf "$task_dir"' EXIT
  curl --fail --location --retry 3 https://nodejs.org/dist/v26.12.1/node-v26.12.1-linux-x64.tar.xz -o "$task_dir/node.tar.xz"
  echo '6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd  node.tar.xz' >"$task_dir/sha256"
  (cd "$task_dir" && sha256sum -c sha256)
  tar -xJf "$task_dir/node.tar.xz" -C /opt
fi
for executable in node npm npx; do
  ln -sfn "/opt/node-v26.12.1-linux-x64/bin/$executable" "/usr/local/bin/$executable"
done
npm_version=$(npm --version)
if [[ "$npm_version" != '12.2.1' ]]; then
  npm install --global --prefix /opt/node-v26.12.1-linux-x64 npm@12.2.1
fi
codex_version=$(codex --version 2>/dev/null) || codex_version=
if [[ "$codex_version" != 'codex-cli 0.163.0' ]]; then
  npm install --global --prefix /usr/local @openai/codex@0.163.0
fi
if ! test -e /home/saqi/.codex/config.toml; then
  cat >/home/saqi/.codex/config.toml <<'CONFIG'
model = "gpt-6.1-sol"
model_reasoning_effort = "xhigh"
service_tier = "default"
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
fast_mode = false
multi_agent = false
shell_tool = false
apps = false
CONFIG
  chown saqi:saqi /home/saqi/.codex/config.toml
  chmod 0600 /home/saqi/.codex/config.toml
fi
if ! test -e /swapfile; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
swapon -a
install -d -m 0755 /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' >/etc/systemd/journald.conf.d/saqi.conf
cat >/etc/apt/apt.conf.d/52saqi <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
APT
touch /var/lib/saqi-bootstrap-complete
printf 'Saqi Codex bootstrap complete.\n'
