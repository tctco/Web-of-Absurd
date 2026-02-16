# Web of Absurd

纯前端（GitHub Pages 友好）的仿 Web of Science 抽象期刊目录。

## 功能

- 支持桌面端表格视图与移动端卡片视图
- 支持 PWA（可安装、基础离线缓存）
- 支持检索（期刊名、主编/编辑部、学科标签、注释）
- 每次刷新随机生成 AIF（`-100 ~ 100`）
- `Rubbish` 固定 `100`；`Joker/Jokers/Joke` 固定 `🤡`
- 按当次 AIF 的四分位点自动分配 `T1 ~ T4`
- 依据当日 GMT 日期（如 `20260215`）作为种子，稳定抽取 `5%` 期刊为 `On Hold`

## 数据来源与转换

源数据：`WOA.md`

执行转换脚本：

```bash
node scripts/md-to-json.mjs
```

会生成：

- `data/journals.json`：当前期刊数据
- `data/journal-count-history.json`：每次生成时的数量历史（时间、总数、分区计数）

可选参数：

```bash
node scripts/md-to-json.mjs <输入md> <输出json> <历史json>
```

## 本地预览

```bash
python3 -m http.server 8080
```

然后访问 `http://localhost:8080`。

## GitHub Pages

- 将仓库推送到 GitHub
- 在仓库 `Settings -> Pages` 中选择分支（通常 `main`）和根目录（`/root`）
- 保存后等待 Pages 构建完成
