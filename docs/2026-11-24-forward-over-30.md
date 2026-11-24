# 超过 30 字发送聊天记录

152、153 的 channels.qq.forwardLongReplyThreshold 设置为 30。

投递逻辑使用严格大于比较：30 字及以内普通消息，31 字起走聊天记录接口。群聊调用 send_group_forward_msg，私聊调用 send_private_forward_msg。最终答复、commentary 和未知阶段的正文均经过该策略；同一最终答复的多个块按总字符数判断。

内部 thinking 通知先过滤，再决定正文是否转发。附件不因通知过滤而丢弃；聊天记录 API 不可用时保留原来的普通消息降级。

验证脚本 tools/verify-forward-30.cjs 从安装源码提取实际投递闭包和转发构造器，仅模拟网络传输及无关上下文服务，不对真实 QQ 联系人发测试消息。两台需分别以其网关 Node 版本运行：

```bash
node tools/verify-forward-30.cjs . /root/.openclaw/openclaw.json
```

30 项回放覆盖群聊/私聊、29/30/31 字、commentary、未知块、多块合计边界、内部通知、通知加附件、转发 API 失败降级。
