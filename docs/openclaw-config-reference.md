# OpenClaw Configuration Reference

Comprehensive reference for all configurable options in the openclaw gateway, derived from the openclaw source code.

## What is OpenClaw

OpenClaw is a personal AI assistant platform you run on your own devices. Key components:

- **Gateway**: WebSocket/HTTP control plane serving channels, sessions, tools, and events (default port: 18789)
- **Channels**: WhatsApp (Baileys), Telegram, Discord, Slack, Google Chat, Signal, iMessage, MS Teams, Matrix, WebChat
- **Agent runtime**: LLM-powered agent with tool use, streaming, sub-agents, and sandboxed execution
- **Canvas**: Live collaborative UI (A2UI)
- **Voice**: TTS + Talk Mode with speech interruption
- **Plugins/Skills/Hooks**: Extensibility system

## Configuration File

**Location**: `~/.openclaw/openclaw.json` (JSON5 format)
**Override**: `OPENCLAW_CONFIG_PATH` env var

---

## Gateway

```jsonc
{
  "gateway": {
    // WebSocket + HTTP multiplexed port (default: 18789)
    // Override: --port <port> or OPENCLAW_GATEWAY_PORT
    "port": 18789,

    // Startup mode: "local" (daemon-managed) or "remote" (CLI connects elsewhere)
    "mode": "local",

    // Bind mode: "loopback" | "auto" | "lan" | "tailnet" | "custom"
    // loopback = 127.0.0.1 only (safest, default)
    // lan = 0.0.0.0 (all interfaces, requires auth)
    // SAFETY: binding beyond loopback without auth is refused
    "bind": "loopback",

    "auth": {
      "mode": "token",           // "token" | "password"
      "token": "...",            // env: OPENCLAW_GATEWAY_TOKEN
      "password": "...",         // env: OPENCLAW_GATEWAY_PASSWORD
      "allowTailscale": false    // trust Tailscale identity headers
    },

    "controlUi": {
      "enabled": true,
      "basePath": "/",
      "root": "...",                 // filesystem root for UI assets
      "allowedOrigins": [],          // CORS origins
      "allowInsecureAuth": false,    // token auth over HTTP
      "dangerouslyDisableDeviceAuth": false
    },

    "tls": {
      "enabled": false,
      "autoGenerate": true,      // auto-gen self-signed cert
      "certPath": "...",
      "keyPath": "...",
      "caPath": "..."            // CA bundle for mTLS
    },

    "reload": {
      "mode": "hybrid",          // "off" | "restart" | "hot" | "hybrid" (default: "hybrid")
      "debounceMs": 300
    },

    "tailscale": {
      "mode": "off",             // "off" | "serve" | "funnel"
      "resetOnExit": false
    },

    "remote": {
      "url": "wss://...",
      "transport": "direct",     // "ssh" | "direct"
      "token": "...",
      "password": "...",
      "tlsFingerprint": "...",
      "sshTarget": "user@host",
      "sshIdentity": "..."
    },

    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": false },
        "responses": {
          "enabled": false,
          "maxBodyBytes": 20971520,
          "files": {
            "allowUrl": true,
            "maxBytes": 5242880,
            "maxChars": 200000,
            "maxRedirects": 3,
            "timeoutMs": 10000,
            "pdf": { "maxPages": 4, "maxPixels": 4000000, "minTextChars": 200 }
          },
          "images": {
            "allowUrl": true,
            "maxBytes": 10485760,
            "maxRedirects": 3,
            "timeoutMs": 10000
          }
        }
      }
    },

    "nodes": {
      "browser": {
        "mode": "auto",          // "auto" | "manual" | "off"
        "node": "..."            // pin to specific node
      },
      "allowCommands": [],
      "denyCommands": []
    },

    "trustedProxies": []
  }
}
```

### Gateway CLI Flags

```bash
openclaw gateway [run] [options]

# Binding & Auth
  --port <port>
  --bind <loopback|lan|tailnet|auto|custom>
  --auth <token|password>
  --token <value>
  --password <value>
  --tailscale <off|serve|funnel>
  --tailscale-reset-on-exit

# Config & Mode
  --allow-unconfigured    # allow start without gateway.mode=local
  --dev                   # create dev config if missing
  --reset                 # reset dev config + sessions (requires --dev)
  --force                 # kill existing listener on port

# Logging
  --verbose
  --claude-cli-logs
  --ws-log <auto|full|compact>
  --compact               # alias for --ws-log compact
  --raw-stream
  --raw-stream-path <path>
```

---

## Agents

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5",
        "fallbacks": ["openai/gpt-4o"]
      },
      "imageModel": { "primary": "...", "fallbacks": [] },
      "models": {},                // model catalog with aliases

      "contextTokens": null,       // context window cap (null = unlimited)
      "workspace": "...",          // agent working directory
      "repoRoot": "...",           // auto-detected
      "skipBootstrap": false,
      "bootstrapMaxChars": 20000,

      "userTimezone": "...",       // IANA timezone
      "timeFormat": "auto",        // "auto" | "12" | "24"
      "envelopeTimezone": "utc",   // "utc" | "local" | "user" | IANA
      "envelopeTimestamp": "on",
      "envelopeElapsed": "on",

      "thinkingDefault": "off",    // "off"|"minimal"|"low"|"medium"|"high"|"xhigh"
      "verboseDefault": "off",     // "off"|"on"|"full"
      "elevatedDefault": "off",    // "off"|"on"|"ask"|"full"

      "blockStreamingDefault": "off",
      "blockStreamingBreak": "text_end",
      "blockStreamingChunk": { "minChars": null, "maxChars": null, "breakPreference": "paragraph" },
      "blockStreamingCoalesce": { "minChars": null, "maxChars": null, "idleMs": null },

      "humanDelay": {
        "mode": "off",             // "off" | "natural" | "custom"
        "minMs": 800,
        "maxMs": 2500
      },

      "timeoutSeconds": null,
      "mediaMaxMb": null,
      "typingIntervalSeconds": null,
      "typingMode": "never",       // "never"|"instant"|"thinking"|"message"
      "maxConcurrent": 1,

      "heartbeat": {
        "every": "30m",
        "activeHours": { "start": "08:00", "end": "20:00", "timezone": "user" },
        "model": "...",
        "session": "...",
        "target": "last",          // "last" | "none" | channel-id
        "to": "...",               // E.164 or chat id
        "prompt": "...",
        "ackMaxChars": 30,
        "includeReasoning": false
      },

      "subagents": {
        "maxConcurrent": 1,
        "archiveAfterMinutes": 60,
        "model": "...",
        "thinking": "..."
      },

      "sandbox": {
        "mode": "off",             // "off" | "non-main" | "all"
        "workspaceAccess": "none", // "none" | "ro" | "rw"
        "scope": "session",        // "session" | "agent" | "shared"
        "docker": {
          "image": "node:20-alpine",
          "network": "none",
          "memory": "1g",
          "cpus": 1,
          "readOnlyRoot": false,
          "capDrop": [],
          "env": {},
          "setupCommand": "..."
        }
      },

      "contextPruning": {
        "mode": "off",             // "off" | "cache-ttl"
        "ttl": "...",
        "keepLastAssistants": null
      },

      "compaction": {
        "mode": "default",         // "default" | "safeguard"
        "reserveTokensFloor": null,
        "maxHistoryShare": 0.5,
        "memoryFlush": { "enabled": true }
      },

      "cliBackends": {}            // text-only fallbacks (e.g., claude-cli)
    },

    // Per-agent definitions
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "...",
        "workspace": "...",
        "model": { "primary": "...", "fallbacks": [] },
        "skills": [],              // skill allowlist (omit = all; empty = none)
        "identity": {
          "name": "...",
          "theme": "...",
          "emoji": "...",
          "avatar": "..."          // path, URL, or data URI
        },
        "groupChat": { "mentionPatterns": [], "historyLimit": null },
        "tools": {},               // per-agent tool policy overrides
        "sandbox": {}              // per-agent sandbox overrides
      }
    ],

    // Route channels/accounts to agents
    "bindings": {}
  }
}
```

---

## Channels

### Shared Channel Options

Every channel supports these options:

```jsonc
{
  "enabled": true,
  "name": "...",
  "dmPolicy": "pairing",          // "pairing"|"allowlist"|"open"|"disabled"
  "allowFrom": [],                // DM allowlist (use ["*"] for open)
  "groupPolicy": "open",          // "open"|"disabled"|"allowlist"
  "groupAllowFrom": [],
  "allowBots": false,
  "requireMention": true,         // in groups
  "historyLimit": null,           // group message history
  "dmHistoryLimit": null,
  "selfChatMode": false,          // same-phone setup (WhatsApp)
  "textChunkLimit": null,         // outbound chunk size
  "chunkMode": "length",          // "length" | "newline"
  "blockStreaming": false,
  "mediaMaxMb": null,
  "responsePrefix": "...",
  "markdown": { "tables": "off" },// "off"|"bullets"|"code"
  "configWrites": true,
  "ackReaction": { "emoji": "👀", "direct": true, "group": "mentions" }
}
```

**DM Policies**:
- `"pairing"` (default): Unknown senders get a pairing code, must be approved via `openclaw pairing approve`
- `"allowlist"`: Only senders in `allowFrom` (or paired store)
- `"open"`: All inbound DMs allowed (requires `allowFrom: ["*"]`)
- `"disabled"`: Ignore all inbound DMs

### WhatsApp

```jsonc
{
  "channels": {
    "whatsapp": {
      "accounts": {
        "default": {
          "authDir": "/path/to/baileys-auth",
          "sendReadReceipts": true,
          "selfChatMode": false,
          "debounceMs": 0,
          "actions": { "reactions": true, "sendMessage": true, "polls": true },
          "groups": {
            "group-jid": { "requireMention": true, "tools": {}, "toolsBySender": {} }
          }
        }
      }
      // + all shared options
    }
  }
}
```

### Telegram

```jsonc
{
  "channels": {
    "telegram": {
      "accounts": {
        "default": {
          "botToken": "...",       // or env: TELEGRAM_BOT_TOKEN
          "tokenFile": "...",      // read token from file
          "replyToMode": "off",    // "off"|"first"|"all"
          "streamMode": "partial", // "off"|"partial"|"block"
          "linkPreview": true,
          "proxy": "...",          // HTTP proxy URL
          "webhookUrl": "...",
          "timeoutSeconds": null,
          "groups": {
            "group-id": {
              "enabled": true,
              "requireMention": true,
              "tools": {},
              "systemPrompt": "..."
            }
          }
        }
      }
    }
  }
}
```

### Discord

```jsonc
{
  "channels": {
    "discord": {
      "accounts": {
        "default": {
          "token": "...",          // or env: DISCORD_BOT_TOKEN
          "allowBots": false,
          "dm": {
            "enabled": true,
            "policy": "pairing",
            "groupEnabled": false
          },
          "guilds": {
            "guild-id": {
              "slug": "...",
              "requireMention": true,
              "channels": {
                "channel-id": { "requireMention": false, "tools": {} }
              }
            }
          },
          "intents": { "presence": false, "guildMembers": false },
          "maxLinesPerMessage": 17,
          "replyToMode": "off"
        }
      }
    }
  }
}
```

### Slack

```jsonc
{
  "channels": {
    "slack": {
      "accounts": {
        "default": {
          "mode": "socket",        // "socket" | "http"
          "botToken": "...",       // or env: SLACK_BOT_TOKEN
          "appToken": "...",       // or env: SLACK_APP_TOKEN
          "requireMention": true,
          "slashCommand": {
            "enabled": false,
            "name": "openclaw",
            "ephemeral": true
          },
          "thread": {
            "historyScope": "thread",
            "inheritParent": false
          },
          "channels": {}
        }
      }
    }
  }
}
```

### Signal

```jsonc
{
  "channels": {
    "signal": {
      "accounts": {
        "default": {
          "account": "+1234567890",
          "httpUrl": "...",
          "httpHost": "127.0.0.1",
          "httpPort": 8080,
          "autoStart": true,
          "sendReadReceipts": true,
          "ignoreAttachments": false
        }
      }
    }
  }
}
```

### Google Chat

```jsonc
{
  "channels": {
    "googlechat": {
      "accounts": {
        "default": {
          "serviceAccountFile": "...",
          "audienceType": "app-url",
          "audience": "...",
          "webhookPath": "/googlechat",
          "typingIndicator": "message"
        }
      }
    }
  }
}
```

### iMessage

```jsonc
{
  "channels": {
    "imessage": {
      "accounts": {
        "default": {
          "cliPath": "imsg",
          "dbPath": "...",
          "service": "auto",       // "imessage"|"sms"|"auto"
          "includeAttachments": false
        }
      }
    }
  }
}
```

### MS Teams

```jsonc
{
  "channels": {
    "msteams": {
      "appId": "...",
      "appPassword": "...",
      "tenantId": "...",
      "webhook": { "port": 3978, "path": "/api/messages" },
      "requireMention": true,
      "replyStyle": "thread"
    }
  }
}
```

---

## Tools

```jsonc
{
  "tools": {
    // Profile presets: "minimal"|"coding"|"messaging"|"full"
    "profile": "minimal",

    "allow": [],                   // allowlist (overrides profile)
    "alsoAllow": [],               // additive allowlist
    "deny": [],                    // denylist

    "exec": {
      "host": "sandbox",           // "sandbox"|"gateway"|"node"
      "security": "deny",          // "deny"|"allowlist"|"full"
      "ask": "on-miss",            // "off"|"on-miss"|"always"
      "pathPrepend": [],
      "safeBins": [],
      "backgroundMs": null,
      "timeoutSec": null,
      "applyPatch": { "enabled": false, "allowModels": [] }
    },

    "media": {
      "concurrency": null,
      "image": {
        "enabled": true,
        "maxBytes": null,
        "maxChars": null,
        "timeoutSeconds": null,
        "models": [
          { "provider": "openai", "model": "gpt-4o", "capabilities": ["image"] }
        ]
      },
      "audio": { "enabled": true },
      "video": { "enabled": true }
    },

    "link": {
      "enabled": true,
      "maxLinks": null,
      "timeoutSeconds": null
    },

    "memory": {}
  }
}
```

---

## Models & Auth

```jsonc
{
  "models": {
    "mode": "merge",               // "merge" (with defaults) | "replace"
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "...",
        "models": [
          {
            "id": "claude-sonnet-4-5",
            "name": "Claude Sonnet 4.5",
            "reasoning": false,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192,
            "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
          }
        ]
      },
      "groq": { "baseUrl": "https://api.groq.com/openai", "models": [] },
      "openai": {},
      "google": {}
      // ... any OpenAI-compatible provider
    }
  },

  "auth": {
    "profiles": {
      "default": { "provider": "anthropic", "mode": "api_key" }
    },
    "order": {
      "anthropic": ["default"]
    },
    "cooldowns": {
      "billingBackoffHours": 5,
      "billingMaxHours": 24,
      "failureWindowHours": 24
    }
  }
}
```

---

## Plugins & Skills

```jsonc
{
  "plugins": {
    "enabled": true,
    "allow": [],                   // plugin id allowlist
    "deny": [],                    // plugin id denylist
    "load": { "paths": [] },
    "slots": { "memory": "..." },
    "entries": {
      "whatsapp": { "enabled": true, "config": {} }
    }
  },

  "skills": {
    "allowBundled": [],            // bundled skill allowlist (omit = all)
    "load": {
      "extraDirs": [],
      "watch": false,
      "watchDebounceMs": null
    },
    "entries": {
      "skill-name": { "enabled": true, "apiKey": "...", "env": {}, "config": {} }
    }
  }
}
```

---

## Messages & Broadcast

```jsonc
{
  "messages": {
    "responsePrefix": "...",       // template: {model}, {provider}, {identity.name}; "auto" for per-request
    "ackReaction": "👀",
    "ackReactionScope": "group-mentions",
    "removeAckAfterReply": false,

    "queue": {
      "mode": "steer",            // "steer"|"followup"|"collect"|"queue"|"interrupt"
      "debounceMs": null,
      "cap": null,
      "drop": "old"               // "old"|"new"|"summarize"
    },

    "inbound": {
      "debounceMs": null,
      "byChannel": {}
    },

    "tts": {
      "auto": "off",              // "off"|"always"|"inbound"|"tagged"
      "provider": "elevenlabs",   // "elevenlabs"|"openai"|"edge"
      "elevenlabs": { "voiceId": "...", "modelId": "..." },
      "openai": { "model": "...", "voice": "..." },
      "maxTextLength": null,
      "timeoutMs": null
    }
  },

  "broadcast": {
    "strategy": "sequential",      // "parallel"|"sequential"
    "peer-id": ["agent1", "agent2"]
  }
}
```

---

## Sessions

```jsonc
{
  "session": {
    "scope": "per-sender",         // "per-sender"|"global"
    "dmScope": "main",             // "main"|"per-peer"|"per-channel-peer"|"per-account-channel-peer"

    "identityLinks": {
      "canonical-peer": ["telegram:123", "discord:456"]
    },

    "reset": {
      "mode": "idle",              // "daily"|"idle"
      "atHour": null,              // 0-23 for daily mode
      "idleMinutes": null
    },
    "resetByChannel": {},          // per-channel reset overrides

    "sendPolicy": {
      "default": "allow",
      "rules": [{ "action": "deny", "match": { "channel": "..." } }]
    },

    "agentToAgent": {
      "maxPingPongTurns": 5
    }
  }
}
```

---

## Hooks (Webhooks & Events)

```jsonc
{
  "hooks": {
    "enabled": false,
    "path": "/hooks",
    "token": "...",
    "maxBodyBytes": null,

    "mappings": [
      {
        "id": "...",
        "match": { "path": "/my-hook", "source": "..." },
        "action": "wake",          // "wake"|"agent"
        "wakeMode": "now",         // "now"|"next-heartbeat"
        "sessionKey": "...",
        "channel": "last",         // or specific channel name
        "to": "...",               // destination
        "model": "...",
        "thinking": "...",
        "timeoutSeconds": null
      }
    ],

    "gmail": {
      "account": "...",
      "includeBody": false,
      "maxBytes": null,
      "renewEveryMinutes": null,
      "tailscale": { "mode": "off" }
    },

    "internal": {
      "enabled": false,
      "entries": {}
    }
  }
}
```

---

## Cron

```jsonc
{
  "cron": {
    "enabled": false,
    "store": "...",
    "maxConcurrentRuns": null
  }
}
```

---

## Memory

```jsonc
{
  "memory": {
    "backend": "builtin",          // "builtin"|"qmd"
    "citations": "auto",           // "auto"|"on"|"off"
    "qmd": {
      "command": "qmd",
      "includeDefaultMemory": false,
      "paths": [{ "path": "...", "name": "...", "pattern": "..." }],
      "sessions": { "enabled": false, "exportDir": "...", "retentionDays": null },
      "update": { "interval": "...", "onBoot": false },
      "limits": {
        "maxResults": null,
        "maxSnippetChars": null,
        "maxInjectedChars": null,
        "timeoutMs": null
      }
    }
  }
}
```

---

## Browser

```jsonc
{
  "browser": {
    "enabled": false,
    "evaluateEnabled": true,
    "cdpUrl": "...",
    "headless": false,
    "noSandbox": false,
    "executablePath": "...",
    "defaultProfile": "chrome",
    "profiles": {
      "chrome": { "cdpPort": null, "color": "#FF4500", "driver": "openclaw" }
    }
  }
}
```

---

## Canvas

```jsonc
{
  "canvasHost": {
    "enabled": false,
    "root": "~/.openclaw/workspace/canvas",
    "port": 18793,
    "liveReload": true
  }
}
```

---

## Logging & Diagnostics

```jsonc
{
  "logging": {
    "level": "info",               // "silent"|"fatal"|"error"|"warn"|"info"|"debug"|"trace"
    "file": "...",
    "consoleLevel": "...",
    "consoleStyle": "pretty",      // "pretty"|"compact"|"json"
    "redactSensitive": "tools"     // "off"|"tools"
  },

  "diagnostics": {
    "enabled": false,
    "otel": {
      "enabled": false,
      "endpoint": "...",
      "protocol": "http/protobuf",
      "serviceName": "openclaw",
      "traces": false,
      "metrics": false,
      "logs": false,
      "sampleRate": 1.0
    },
    "cacheTrace": {
      "enabled": false,
      "filePath": "..."
    }
  }
}
```

---

## Commands & Approvals

```jsonc
{
  "commands": {
    "native": "auto",
    "text": true,
    "bash": false,                 // allow !bash (disabled by default)
    "config": false,               // allow /config
    "debug": false,                // allow /debug
    "restart": false,              // allow restart
    "useAccessGroups": true,
    "ownerAllowFrom": []
  },

  "approvals": {
    "exec": {
      "enabled": false,
      "mode": "session",           // "session"|"targets"|"both"
      "targets": [
        { "channel": "discord", "to": "user-id" }
      ]
    }
  }
}
```

---

## Discovery

```jsonc
{
  "discovery": {
    "wideArea": { "enabled": false, "domain": "..." },
    "mdns": { "mode": "minimal" } // "off"|"minimal"|"full"
  }
}
```

---

## Environment Variables

### Core

| Variable | Purpose |
|----------|---------|
| `OPENCLAW_CONFIG_PATH` | Config file path override |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway auth token |
| `OPENCLAW_GATEWAY_PASSWORD` | Gateway auth password |
| `OPENCLAW_GATEWAY_PORT` | Gateway port override |
| `OPENCLAW_PROFILE` | Set to `"dev"` for dev mode |

### Provider API Keys

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) |
| `OPENAI_API_KEY` | OpenAI |
| `GOOGLE_API_KEY` | Google (Gemini) |
| `GEMINI_API_KEY` | Google (Gemini, alias) |
| `OPENROUTER_API_KEY` | OpenRouter |
| `XAI_API_KEY` | xAI (Grok) |
| `GROQ_API_KEY` | Groq |
| `MISTRAL_API_KEY` | Mistral |
| `TOGETHER_API_KEY` | Together AI |
| `PERPLEXITY_API_KEY` | Perplexity |
| `CEREBRAS_API_KEY` | Cerebras |

### Channel Tokens

| Variable | Channel |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Discord |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack app token |
| `TELEGRAM_BOT_TOKEN` | Telegram |

### Other

| Variable | Purpose |
|----------|---------|
| `ELEVENLABS_API_KEY` | TTS provider |
| `NODE_DISABLE_COMPILE_CACHE` | Disable V8 compile cache |

---

## What We Configure in Claudio

In our deploy provisioner (`src/deploy/provisioner-docker.ts`), we generate an `openclaw.json` per user with:

- `gateway.auth` — token mode with per-user generated token
- `gateway.controlUi` — allowed origins pointing to our deploy server, insecure auth enabled
- `channels.whatsapp` — allowlist DM policy, user's WhatsApp ID, self-chat mode, per-user auth dir
- `plugins.entries.whatsapp` — enabled
- `agents.defaults` — model primary/fallbacks and context tokens based on selected tier
- `tools.profile` — "minimal"

See `buildConfig()` in `src/deploy/provisioner-docker.ts` for the exact config shape.
