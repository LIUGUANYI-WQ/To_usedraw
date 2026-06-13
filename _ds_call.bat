@echo off
curl -s --max-time 30 https://api.deepseek.com/v1/chat/completions -H "Content-Type: application/json" -H "Authorization: Bearer sk-13bf0defa6bd4d47be7f3026d29d0ce3" -d @_ds_req.json > _ds_resp.txt 2>&1
