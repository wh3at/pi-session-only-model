# Secure npm Publication Referent Table

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 初出定義 | 候補語 |
| --- | --- | --- | --- | --- | --- | --- |
| ユーザー要望 | npmからPiへ導入可能にする | npm上の`pi-session-only-model`を`pi install npm:pi-session-only-model`で導入できる状態 | 目的 | GitHub公開 → npm公開 → Pi導入 |  | Pi package publication |
| ユーザー選択 | 公開対象をレビュー済みに限定する | `package.json`とCHANGELOGを更新した`main`上のcommitを指す一致versionタグ | 開始条件 | PRマージ → versionタグpush → 公開 |  | release tag |
| セキュリティ要望 | 長期公開資格情報を保持しない | npmがGitHub Actions workflowをOIDCで信頼して一時認証する関係 | 手段 | release tag検証 → OIDC認証 → npm公開 |  | Trusted Publishing |
| セキュリティ要望 | 改変・誤公開の余地を最小化する | 最小権限、外部Actionのcommit SHA固定、公開物検査、provenanceを組み合わせた公開経路 | 手段 | PR検証 → release tag検証 → provenance付き公開 | 本文でいうsecure release pathとは、この組み合わせでnpm公開へ到達する経路を指す | secure release path |
| ユーザー追加要望 | Pi利用者から発見可能にする | npm公開済みで`pi-package` keywordを持ち、`pi.dev/packages`の収集対象となるパッケージ | 目的 | npm公開 → カタログ収集 → 掲載確認 |  | Pi package catalog listing |
| npm制約とユーザー選択 | 初回公開後にOIDC経路を実証可能にする | `0.0.0`を短期限tokenで一度だけ公開し、Trusted Publisher設定後に`v0.1.0`を公開する初期化手順 | 手段 | public repo作成 → 0.0.0公開 → Trusted Publisher設定 → v0.1.0公開 | 本文でいうbootstrap publicationとは、OIDCを設定できない未登録packageを一度だけ登録する公開を指す | bootstrap publication |
