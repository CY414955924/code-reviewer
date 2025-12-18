#!/bin/bash

echo "开始设置和验证..."

# 初始化错误收集
ERRORS=()

# 检查必要的环境变量
echo "检查环境变量..."
required_vars=(
  "GITHUB_REPOSITORY"
  "GITHUB_REPOSITORY_OWNER"
  "GITHUB_EVENT_NAME"
  "GITHUB_EVENT_PATH"
  "GITHUB_OUTPUT"
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "::error::缺少必要的环境变量: $var"
    ERRORS+=("缺少必要的环境变量: $var")
  else
    echo "环境变量 $var 已设置"
  fi
done

# 生成配置文件
echo "正在生成配置文件..."
if ! .github/generate-config.sh --output .encode_review.yml; then
  echo "::error::配置文件生成失败"
  ERRORS+=("配置文件生成失败")
else
  echo "配置文件生成成功"
fi

# 验证配置文件
echo "验证配置文件..."
if [ ! -f ".encode_review.yml" ]; then
  echo "::error::配置文件不存在"
  ERRORS+=("配置文件不存在")
else
  file_size=$(stat -c%s ".encode_review.yml" 2>/dev/null || stat -f%z ".encode_review.yml")
  echo "配置文件大小: $file_size 字节"
  if [ "$file_size" -lt 10 ]; then
    echo "::error::配置文件为空"
    ERRORS+=("配置文件为空")
  fi
fi

# 验证API密钥
echo "验证API密钥..."
if [ -z "$API_KEY" ]; then
  echo "::error::API密钥未设置"
  ERRORS+=("API密钥未设置")
elif [[ ! "$API_KEY" =~ ^(sk-|sk-or-) ]]; then
  echo "::error::API密钥格式无效"
  ERRORS+=("API密钥格式无效")
else
  echo "API密钥验证成功"
fi

# 验证GitHub Token
echo "验证GitHub Token..."
if [ -z "$AI_REVIEWER_GITHUB_TOKEN" ]; then
  echo "::error::GitHub Token未设置"
  ERRORS+=("GitHub Token未设置")
else
  # 测试API连接和权限
  echo "测试仓库访问权限..."
  repo_response=$(curl -s -w "%{http_code}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: token $AI_REVIEWER_GITHUB_TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$GITHUB_REPOSITORY")
  repo_status=${repo_response: -3}
  repo_body=${repo_response:0:${#repo_response}-3}

  echo "测试Issues访问权限..."
  issues_response=$(curl -s -w "%{http_code}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: token $AI_REVIEWER_GITHUB_TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/issues")
  issues_status=${issues_response: -3}
  issues_body=${issues_response:0:${#issues_response}-3}

  if [ "$repo_status" = "200" ] && [ "$issues_status" = "200" ]; then
    echo "GitHub Token权限验证成功"
    echo "- 仓库访问权限: 通过"
    echo "- Issues访问权限: 通过"
  else
    echo "::error::GitHub Token权限验证失败"
    if [ "$repo_status" != "200" ]; then
      echo "仓库访问失败: $repo_status"
      echo "响应: $repo_body"
      ERRORS+=("GitHub Token缺少仓库访问权限: $repo_status $repo_body")
    fi
    if [ "$issues_status" != "200" ]; then
      echo "Issues访问失败: $issues_status"
      echo "响应: $issues_body"
      ERRORS+=("GitHub Token缺少Issues访问权限: $issues_status $issues_body")
    fi
  fi
fi

# 获取PR信息
echo "获取PR信息..."
if [ "$GITHUB_EVENT_NAME" = "pull_request" ]; then
  # 从事件文件中获取PR编号
  PR_NUMBER=$(jq -r '.pull_request.number' "$GITHUB_EVENT_PATH")
else
  # 从输入参数获取PR编号
  PR_NUMBER=${{ inputs.pr_number }}
fi

if [ -z "$PR_NUMBER" ]; then
  echo "::error::无法获取PR编号"
  ERRORS+=("无法获取PR编号")
else
  echo "PR编号: $PR_NUMBER"
  # 验证PR是否存在
  response=$(curl -s -w "%{http_code}" \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: token $AI_REVIEWER_GITHUB_TOKEN" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER")
  status_code=${response: -3}
  body=${response:0:${#response}-3}

  if [ "$status_code" = "200" ]; then
    echo "PR验证成功"
    echo "pr_number=$PR_NUMBER" >> $GITHUB_OUTPUT
  else
    echo "::error::PR #$PR_NUMBER 不存在或无法访问"
    echo "状态码: $status_code"
    echo "响应: $body"
    ERRORS+=("PR #$PR_NUMBER 不存在或无法访问: $status_code $body")
  fi
fi

# 设置验证状态
if [ ${#ERRORS[@]} -eq 0 ]; then
  echo "所有验证通过"
  echo "setup_valid=true" >> $GITHUB_OUTPUT

  # 🔴 将环境变量写入 GITHUB_ENV，使后续步骤可用
  if [ -n "$AI_REVIEWER_OPENAI_KEY" ]; then
    echo "AI_REVIEWER_OPENAI_KEY=$AI_REVIEWER_OPENAI_KEY" >> $GITHUB_ENV
  fi
  
  if [ -n "$AI_REVIEWER_GITHUB_TOKEN" ]; then
    echo "AI_REVIEWER_GITHUB_TOKEN=$AI_REVIEWER_GITHUB_TOKEN" >> $GITHUB_ENV
  fi
  
  if [ -n "$AI_REVIEWER_MODEL" ]; then
    echo "AI_REVIEWER_MODEL=$AI_REVIEWER_MODEL" >> $GITHUB_ENV
  fi
  
  if [ -n "$AI_REVIEWER_BASE_URL" ]; then
    echo "AI_REVIEWER_BASE_URL=$AI_REVIEWER_BASE_URL" >> $GITHUB_ENV
  fi


else
  echo "发现 ${#ERRORS[@]} 个错误"
  echo "setup_valid=false" >> $GITHUB_OUTPUT
  # 将错误信息转换为单行字符串
  echo "errors=$(printf '%s\n' "${ERRORS[@]}" | tr '\n' '|')" >> $GITHUB_OUTPUT
fi 
