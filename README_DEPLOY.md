# Quem é Mais Vulnerável no Território? — Dourados/MS — Publicar o WebGIS

Este site foi gerado pelo plugin **WebGIS Exporter** do QGIS. Ele é
100% estático (HTML/CSS/JS) e não precisa de servidor especial.

## 1. Testar localmente (opcional)

Abra um terminal nesta pasta e rode:

```
python -m http.server 8000
```

Depois acesse http://localhost:8000 no navegador.
(Abrir o `index.html` direto com duplo clique pode falhar por causa do
carregamento dos arquivos `.geojson` — use sempre um servidor local,
mesmo que simples, para testar.)

## 2. Publicar no GitHub

```
git init
git add .
git commit -m "Publica WebGIS"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

## 3. Publicar no Netlify

Opção A — arrastar e soltar (mais simples):
1. Acesse https://app.netlify.com/drop
2. Arraste esta pasta inteira para a página.
3. Pronto — o Netlify gera o link público em segundos.

Opção B — conectado ao GitHub (recomendado, com deploy automático):
1. Acesse https://app.netlify.com e clique em "Add new site" → "Import an existing project".
2. Escolha o repositório do GitHub criado no passo 2.
3. Build command: deixe em branco. Publish directory: `.`
4. Clique em "Deploy site".

A partir daí, todo `git push` atualiza o site automaticamente.

## Observações

- Os arquivos `.geojson.gz` são versões comprimidas dos dados; o
  `netlify.toml` já está configurado para servi-los corretamente.
  Se for publicar em outro serviço (GitHub Pages, por exemplo), a
  compressão gzip automática do servidor também funciona — os
  arquivos `.geojson` normais continuam funcionando sem configuração.
- Para trocar o título, logo ou texto "Sobre/Autores" depois, edite o
  arquivo `config.json` (não precisa reabrir o QGIS) ou gere o site
  novamente pelo plugin.
