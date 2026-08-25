# youtube-mcp-server

Servidor MCP (Model Context Protocol) que permite a um agente de IA (Claude, etc.) pesquisar
vídeos no YouTube sobre um assunto, verificar as visualizações reais e retornar os **10 vídeos
mais vistos** sobre esse tema, junto com uma análise agregada (engajamento, canais dominantes,
palavras-chave dos títulos, duração, período de publicação etc.).

## Sobre a conta Premium do YouTube

O YouTube Premium (assinatura de consumidor, sem anúncios/downloads) **não concede acesso à API**.
O acesso programático usado por este servidor é feito através da **YouTube Data API v3**, do Google
Cloud, que é gratuita (cota diária generosa) e independente de qualquer assinatura do YouTube.
Não há como "aproveitar" a conta Premium aqui — é preciso apenas uma chave de API do Google Cloud.

## Como obter a chave de API (gratuita)

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie um projeto (ou use um existente).
3. Em **APIs e Serviços → Biblioteca**, ative a **YouTube Data API v3**.
4. Em **APIs e Serviços → Credenciais**, clique em **Criar credenciais → Chave de API**.
5. (Recomendado) Restrinja a chave à YouTube Data API v3.
6. Copie a chave gerada.

A cota gratuita padrão é de 10.000 unidades/dia. Uma chamada de `youtube_analyze_topic` custa
cerca de 100-102 unidades (uma busca + uma consulta de vídeos + uma consulta de canais), o que dá
para ~90 análises completas por dia no plano gratuito.

## Instalação

```bash
npm install
npm run build
```

## Configuração

Defina a variável de ambiente `YOUTUBE_API_KEY` com a chave obtida acima (veja `.env.example`).

### Uso com Claude Code

```bash
claude mcp add youtube -- node /caminho/absoluto/para/dist/index.js
```

e defina `YOUTUBE_API_KEY` no ambiente, ou adicione ao arquivo de configuração MCP:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/caminho/absoluto/para/dist/index.js"],
      "env": {
        "YOUTUBE_API_KEY": "sua_chave_aqui"
      }
    }
  }
}
```

## Ferramentas disponíveis

- **`youtube_analyze_topic`** — ferramenta principal. Pesquisa um assunto, confere as
  visualizações reais de um conjunto de vídeos candidatos, reordena por visualizações e retorna
  os top N (padrão 10), com estatísticas de cada vídeo (visualizações, curtidas, comentários, taxa
  de engajamento, duração) e uma análise agregada (total/média de visualizações, canais que mais
  aparecem, palavras-chave comuns nos títulos, faixa de datas de publicação, faixa de duração).
  Suporta filtros por data de publicação, duração e idioma/região.
- **`youtube_search_videos`** — busca simples no YouTube com metadados e estatísticas, ordenável
  por relevância, visualizações, data ou avaliação.
- **`youtube_get_video_details`** — detalhes completos de vídeos específicos, por ID ou URL.
- **`youtube_get_channel_details`** — inscritos, total de vídeos e visualizações de um canal.

Todas as ferramentas são somente leitura (não publicam, curtem ou modificam nada) e suportam
`response_format` (`markdown` ou `json`).

## Desenvolvimento

```bash
npm run dev     # roda com tsx e recarrega automaticamente
npm run build   # compila para dist/
npm start        # roda a versão compilada
```

## Limitações conhecidas

- `order=viewCount` na busca do YouTube reflete o ranking interno do YouTube, não
  necessariamente o número exato de visualizações no momento da consulta — por isso
  `youtube_analyze_topic` sempre reconfirma e reordena pelos números reais retornados por
  `videos.list`.
- Vídeos com curtidas ou comentários ocultos pelo criador aparecem como `null`/"hidden" nesses
  campos; a taxa de engajamento é `null` quando não há dados suficientes.
- A API não expõe watch time, retenção ou dados de audiência — apenas métricas públicas
  (visualizações, curtidas, comentários, metadados).
