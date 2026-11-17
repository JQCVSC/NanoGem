FROM node:22-bookworm-slim

ARG SANDBOX_UID=1000
ARG SANDBOX_GID=1000

# Install Python, git, and standard CLI utilities for sandboxed execution.
# Reject root/non-numeric UID/GID and strip setuid/setgid bits as defense-in-depth
# alongside --cap-drop=ALL and no-new-privileges.
RUN printf '%s' "${SANDBOX_UID}" | grep -Eq '^[1-9][0-9]*$' \
  && printf '%s' "${SANDBOX_GID}" | grep -Eq '^[1-9][0-9]*$' \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    python3 \
    python3-pip \
    python3-venv \
    python-is-python3 \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && find / -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true

# Replace default 'node' user/group (UID/GID 1000) with dedicated non-root 'sandbox' account.
RUN (userdel -r node 2>/dev/null || true) \
  && (groupdel node 2>/dev/null || true) \
  && groupadd -g "${SANDBOX_GID}" sandbox \
  && useradd -m -u "${SANDBOX_UID}" -g "${SANDBOX_GID}" -d /home/sandbox -s /bin/bash sandbox \
  && mkdir -p /workspace \
  && chown -R "${SANDBOX_UID}:${SANDBOX_GID}" /workspace /home/sandbox

ENV HOME=/home/sandbox \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    NPM_CONFIG_CACHE=/home/sandbox/.npm

WORKDIR /workspace
USER sandbox

CMD ["/bin/bash"]
