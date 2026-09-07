# 通知卡片模板（可选，飞书集成用）

录入完成后向用户推送的卡片结构。未启用飞书集成时可忽略此文件。

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "title": { "tag": "plain_text", "content": "录入完成" } },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**<词条标题>**（<类型>）" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "- <要点 1>\n- <要点 2>" } },
    { "tag": "action", "actions": [
      { "tag": "button", "text": { "tag": "plain_text", "content": "打开词条" },
        "url": "<词条链接>", "type": "primary" }
    ]}
  ]
}
```
