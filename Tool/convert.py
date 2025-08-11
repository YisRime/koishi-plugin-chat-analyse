# final_converter_with_report.py

import json
import os
import glob
import re

def get_allowed_guild_ids():
    """
    从一个多行字符串中解析出所有频道ID，并返回一个集合。
    """
    # 您可以在这里编辑和维护您的频道白名单
    raw_guild_list = """
    [1033929807]
    """
    ids = re.findall(r'\d+', raw_guild_list)
    return set(ids)

def final_batch_convert_with_report():
    """
    查找、筛选并批量转换 stat-*.json 文件，并在最后报告被忽略的频道列表。
    """
    allowed_ids = get_allowed_guild_ids()
    if not allowed_ids:
        print("错误: 频道ID白名单为空。")
        return

    print(f"筛选器已加载，将只处理 {len(allowed_ids)} 个指定频道的数据。")
    print("-" * 30)

    file_list = glob.glob('stat-*.json')
    if not file_list:
        print("错误: 在当前目录下未找到 'stat-*.json' 文件。")
        return

    print(f"找到 {len(file_list)} 个待处理的文件...")

    users_data = {}
    all_msg_records = []
    all_cmd_records = []
    total_records_count = 0
    kept_records_count = 0
    ignored_guilds = set() # --- 新增：用于存放被忽略的频道ID ---

    for filename in file_list:
        print(f"正在处理: {filename}...")
        with open(filename, 'r', encoding='utf-8') as f:
            try:
                source_data = json.load(f)
            except json.JSONDecodeError:
                print(f"  -> 警告: '{filename}' 文件格式错误，已跳过。")
                continue

        for record in source_data:
            total_records_count += 1
            guild_id = record.get('guildId')

            # 核心筛选逻辑
            if guild_id and guild_id in allowed_ids:
                kept_records_count += 1
                user_key = f"{record.get('userId', '')}:{guild_id}"

                if user_key not in users_data:
                    users_data[user_key] = {
                        "userId": record['userId'],
                        "channelId": record['guildId'],
                        "channelName": record.get('guildName', ''),
                        "userName": record.get('userName', '')
                    }
                else:
                    if record.get('userName'):
                        users_data[user_key]['userName'] = record['userName']
                    if record.get('guildName'):
                        users_data[user_key]['channelName'] = record['guildName']

                command = record.get('command')
                if command == '_message':
                    all_msg_records.append({
                        "userId": record['userId'],
                        "channelId": record['guildId'],
                        "type": "text",
                        "count": record.get('count', 1),
                        "timestamp": record['lastTime']
                    })
                elif command:
                    all_cmd_records.append({
                        "userId": record['userId'],
                        "channelId": record['guildId'],
                        "command": command,
                        "count": record.get('count', 1),
                        "timestamp": record['lastTime']
                    })
            else:
                # --- 新增：如果频道ID存在但未被处理，则记录下来 ---
                if guild_id:
                    ignored_guilds.add(guild_id)

    # --- 报告和总结部分 ---
    print("-" * 30)
    print("所有文件处理完毕。")
    print(f"总共扫描了 {total_records_count} 条记录，保留了 {kept_records_count} 条有效记录。")

    # --- 新增：打印被忽略的频道列表 ---
    if ignored_guilds:
        print(f"\n在处理过程中，以下 {len(ignored_guilds)} 个频道的记录被忽略（因为它们不在白名单中）:")
        # 将ID转换为整数进行排序，以获得更自然的排序结果
        sorted_ignored_guilds = sorted([int(gid) for gid in ignored_guilds])
        for gid in sorted_ignored_guilds:
            print(f"- {gid}")
    else:
        print("\n所有找到的频道都在白名单内，没有忽略任何频道的数据。")

    print("-" * 30)

    # --- 文件写入部分 ---
    final_users_list = list(users_data.values())

    output_files = {
        'analyse_user.json': final_users_list,
        'analyse_msg.json': all_msg_records,
        'analyse_cmd.json': all_cmd_records
    }

    for filename, data in output_files.items():
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"成功生成文件: {filename}，包含 {len(data)} 条记录。")

    print("\n转换完成！")


if __name__ == '__main__':
    final_batch_convert_with_report()
