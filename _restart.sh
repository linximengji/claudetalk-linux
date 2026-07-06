#!/bin/bash
pid=$(cat D:/ClaudeProjects/.claudetalk/claudetalk-default.pid)
echo "Killing claudetalk PID=$pid"
kill "$pid" 2>/dev/null || taskkill //PID "$pid" //F 2>/dev/null
sleep 5
pid2=$(cat D:/ClaudeProjects/.claudetalk/claudetalk-default.pid 2>/dev/null)
echo "New PID: $pid2"
