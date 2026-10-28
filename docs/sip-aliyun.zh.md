# 阿里云 SIP 中继（企业版，默认关闭）

个人版不拨打真实电话。开通方式见 [ADR](adr/0007-voice-and-pstn.zh.md)：企业套餐且 `PSTN_ENABLED=1`，或本机试用 `HEARTH_DEV_PSTN=1`。下面的地址来自阿里云帮助中心，核对日期 2026-10-28。

## 生产中继是 IP 对接，不是注册

[语音 SIP 接入流程](https://help.aliyun.com/zh/vms/voice-sip-access-process) 写明：SIP Trunk **没有账号和密码**，呼出靠 IP 白名单和线下约定的被叫前缀。信令端口 **5060**。

| 地域 | 呼出域名 |
|---|---|
| 上海 | `sh.siptrunk.aliyun.com` |
| 北京 | `bj.siptrunk.aliyun.com` |
| 深圳 | `sz.siptrunk.aliyun.com` |

公开文档把媒体地址打成了 `47.103.XXX.XX` 这种掩码。不要把掩码补全后写进配置。向阿里云技术支持要未打码的信令 IP 和媒体 IP，再填安全组。

从试用切到生产只改环境变量：`SIP_PROFILE=aliyun-prod`、`SIP_REGION`、`SIP_PUBLIC_IP`（云服务器 EIP）、`SIP_CALLER_ID`、`SIP_CALLED_PREFIX`。`aliyun-prod` 默认是 IP 模式，会忽略试用时留下的用户名口令，除非显式设置 `SIP_TRUNK_MODE=register`。

## 试用线路可能是注册

公开文档没有单独的「试用 SIP 主机名」。试用账号发下来的如果是用户名和口令，用 `SIP_PROFILE=aliyun-trial`（有用户名时默认注册）。生产语音服务中继不要向 `sh.siptrunk.aliyun.com` 发 REGISTER。

## 编码、端口、安全组

- 语音服务页面没有公布客户侧 RTP 端口范围。阿里云实时音视频 SIP 示例使用 **PCMA/8000**（payload 8）。预设编码是 `PCMA,PCMU`，以账号技术对接确认为准。
- 本服务默认把 RTP 绑在 UDP `10000–10199`，可改 `SIP_RTP_PORT_MIN` / `SIP_RTP_PORT_MAX`。云联络中心文档里的 `40000–60000` 是**他们**的媒体侧，不是我们的端口。
- SDP 的 `c=` 和 Contact 必须是 EIP，不能是 VPC 内网地址。
- 安全组：入方向 UDP 5060 和 RTP 段只放行阿里云给出的对端地址；出方向访问所选地域的 5060。拿到未掩码地址之前，不要对 `0.0.0.0/0` 长期开放 5060。中间 NAT 关掉 SIP ALG。

呼入送号格式是区号加 7 到 8 位本地号码。自定义 SIP 码 470–477 的含义在同一篇帮助文档里（欠费、超频、黑名单、非法主叫、选路失败、配置错误）。

## 本机端口怎么发布

默认的 `docker-compose.yml` 不映射 5060 和 RTP，避免个人版把信令口暴露出去。企业版开通后：

```bash
docker compose -f docker-compose.yml -f docker-compose.pstn.yml up -d
```

`docker-compose.pstn.yml` 把网关的 UDP 5060 和 UDP `SIP_RTP_PORT_MIN`–`SIP_RTP_PORT_MAX`（默认 10000–10199）发布到宿主机。同时设置 `SIP_ENABLED=1`、`PSTN_ENABLED=1`，并把租户套餐设为企业版；本地试用阿里云线路时用 `HEARTH_DEV_PSTN=1`。`SIP_ENABLED=1` 已经写在 `.env` 里时，`install.sh` 和 `deploy/upgrade.sh` 会自动加上这个覆盖文件。安全组仍然只放行阿里云对端地址。
