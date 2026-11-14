require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} = require('discord.js');

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  entersState
} = require('@discordjs/voice');

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const songs = require('./songs.json');

// =====================================
// CONFIG
// =====================================

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const MAX_FILE_SIZE = 100 * 1024 * 1024;

if (!TOKEN) {
  throw new Error('ไม่พบ BOT_TOKEN ในไฟล์ .env');
}

if (!ffmpegPath) {
  throw new Error('ไม่พบ FFmpeg กรุณาติดตั้ง ffmpeg-static');
}

console.log('========== BOOMBOX DEBUG ==========');
console.log('FFmpeg:', ffmpegPath);
console.log('Songs:', Object.keys(songs).length);
console.log('===================================');

// =====================================
// DISCORD CLIENT
// =====================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

// =====================================
// GUILD AUDIO STATES
// =====================================

const guildPlayers = new Map();

function startQueuedSong(
  state,
  guildId,
  expectedLoadId = null,
  expectedPlaybackId = null
) {
  if (
    (expectedLoadId !== null && state.loadId !== expectedLoadId) ||
    (expectedPlaybackId !== null && state.playbackId !== expectedPlaybackId)
  ) {
    return;
  }

  if (
    state.isLoading ||
    state.player.state.status !== AudioPlayerStatus.Idle ||
    state.queue.length === 0 ||
    !state.playbackContext
  ) {
    return;
  }

  const nextSongId = state.queue.shift();
  const loadId = ++state.loadId;
  state.isLoading = true;

  playSong(state.playbackContext, nextSongId)
    .then(song => {
      console.log(`[${guildId}] AUTO NEXT: ${song.name}`);
    })
    .catch(error => {
      console.error(`[${guildId}] AUTO NEXT ERROR:`, error);

      if (state.loadId === loadId && state.queue.length > 0) {
        const failedPlaybackId = state.playbackId;

        setImmediate(() => {
          startQueuedSong(
            state,
            guildId,
            loadId,
            failedPlaybackId
          );
        });
      }
    })
    .finally(() => {
      if (state.loadId === loadId) {
        state.isLoading = false;
        refreshPanel(state);
      }
    });
}

function getGuildState(guildId) {
  if (guildPlayers.has(guildId)) {
    return guildPlayers.get(guildId);
  }

  const player = createAudioPlayer();

  const state = {
    player,
    connection: null,
    ffmpeg: null,
    resource: null,
    currentSong: null,
    queue: [],
    playbackContext: null,
    isLoading: false,
    loadId: 0,
    playbackId: 0,
    downloadController: null,
    tempDir: null,
    panelMessage: null,
    startedAt: null,
    durationMs: 0,
    panelInterval: null
  };

  player.on('stateChange', (oldState, newState) => {
    console.log(
      `[${guildId}] PLAYER: ${oldState.status} -> ${newState.status}`
    );

    if (newState.status === AudioPlayerStatus.Playing) {
      startPanelTicker(state);
    } else {
      stopPanelTicker(state);
    }

    // เพลงจบตามปกติ
    if (
      oldState.status !== AudioPlayerStatus.Idle &&
      newState.status === AudioPlayerStatus.Idle
    ) {
      const oldResource = oldState.resource;
      const oldPlaybackId = oldResource?.metadata?.playbackId;

      // ป้องกัน Idle event ของเพลงเก่าปิดเพลงใหม่
      if (oldPlaybackId === state.playbackId) {
        stopFFmpeg(state);

        state.resource = null;
        state.currentSong = null;
        state.startedAt = null;
        state.durationMs = 0;

        cleanupTempFile(state);
        refreshPanel(state);

        if (state.queue.length > 0 && state.playbackContext) {
          const expectedLoadId = state.loadId;

          setImmediate(() => {
            startQueuedSong(
              state,
              guildId,
              expectedLoadId,
              oldPlaybackId
            );
          });
        }
      }
    }
  });

  player.on('error', error => {
    console.error(`[${guildId}] PLAYER ERROR:`, error);

    const failedPlaybackId = state.playbackId;

    stopMusic(state);

    if (state.queue.length > 0 && state.playbackContext) {
      const expectedLoadId = ++state.loadId;

      setImmediate(() => {
        startQueuedSong(
          state,
          guildId,
          expectedLoadId,
          failedPlaybackId + 1
        );
      });
    }
  });

  guildPlayers.set(guildId, state);

  return state;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getMediaDuration(filePath) {
  return new Promise(resolve => {
    let stderr = '';

    const probe = spawn(ffmpegPath, [
      '-hide_banner',
      '-i', filePath,
      '-t', '0',
      '-f', 'null',
      '-'
    ], {
      stdio: ['ignore', 'ignore', 'pipe']
    });

    probe.stderr.on('data', data => {
      stderr += data.toString();

      if (stderr.length > 20000) {
        stderr = stderr.slice(-20000);
      }
    });

    probe.on('error', error => {
      console.error('[DURATION PROBE ERROR]', error.message);
      resolve(0);
    });

    probe.on('close', () => {
      const match = stderr.match(
        /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i
      );

      if (!match) {
        console.warn('[DURATION] Could not detect media duration');
        resolve(0);
        return;
      }

      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);

      resolve(Math.round(
        (hours * 3600 + minutes * 60 + seconds) * 1000
      ));
    });
  });
}

function stopPanelTicker(state) {
  if (state.panelInterval) {
    clearInterval(state.panelInterval);
    state.panelInterval = null;
  }
}

function startPanelTicker(state) {
  if (state.panelInterval) return;

  state.panelInterval = setInterval(() => {
    if (state.player.state.status !== AudioPlayerStatus.Playing) {
      stopPanelTicker(state);
      return;
    }

    refreshPanel(state);
  }, 1000);
}

// =====================================
// BOX MUSIC PANEL
// =====================================

function createPanel(state) {
  const status =
    state.player.state.status === AudioPlayerStatus.Playing
      ? '🔴 กำลังเล่น'
      : state.player.state.status === AudioPlayerStatus.Paused
        ? '⏸️ พักเพลง'
        : state.isLoading
          ? '🟡 กำลังโหลดเพลง'
          : '⚫ พร้อมใช้งาน';

  const elapsedMs = state.resource?.playbackDuration || 0;
  const elapsedText = formatDuration(elapsedMs);
  const totalText = formatDuration(state.durationMs);
  const timeText = state.currentSong
    ? `${elapsedText} / ${totalText}`
    : '00:00 / 00:00';

  const queueText = state.queue.length
    ? state.queue.slice(0, 10).map((id, index) =>
        `${index + 1}. ${songs[id]?.name || 'ไม่พบชื่อเพลง'}`
      ).join('\n')
    : 'ไม่มีเพลงในคิว';

  const selectRow = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('v2_select_song')
        .setPlaceholder('🎧 เลือกเพลงที่ต้องการ')
       .addOptions(
  Object.entries(songs)
  .sort(([, a], [, b]) => {
    const artistCompare = (a.artist || 'ไม่ระบุศิลปิน')
      .localeCompare(b.artist || 'ไม่ระบุศิลปิน', 'en', { sensitivity: 'base' });

    if (artistCompare !== 0) return artistCompare;

    return (a.name || '').localeCompare(b.name || '', 'th');
  })
  .slice(0, 25)
  .map(([id, song]) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(song.name.slice(0, 100))
      .setDescription((song.artist || 'ไม่ระบุศิลปิน').slice(0, 100))
      .setValue(id)
  )
)
    );

  const buttonRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('v2_pause')
        .setLabel('พัก / เล่นต่อ')
        .setEmoji('⏯️')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId('v2_skip')
        .setLabel('ข้ามเพลง')
        .setEmoji('⏭️')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId('v2_stop')
        .setLabel('หยุดเพลง')
        .setEmoji('⏹️')
        .setStyle(ButtonStyle.Danger)
    );

  return new ContainerBuilder()
    .setAccentColor(0xE50914)
    .addTextDisplayComponents(
      new TextDisplayBuilder()
        .setContent(
          '# 🔴 BOX MUSIC\n' +
          '### MUSIC PLAYER SYSTEM\n' +
          '━━━━━━━━━━━━━━━━━━━━\n\n' +
          '## 🎧 NOW PLAYING\n' +
          `**${state.currentSong || 'ยังไม่มีเพลงกำลังเล่น'}**\n\n` +
          `🕒 เวลา: ${timeText}\n` +
          `📡 สถานะ: **${status}**`
        )
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Large)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder()
        .setContent(
          '## 🎼 MUSIC LIBRARY\n' +
          'เลือกเพลงจากเมนูด้านล่าง\n\n' +
          '## 📜 PLAYLIST QUEUE\n' +
          `${queueText}\n\n` +
          `📀 จำนวนเพลงในคิว: **${state.queue.length} เพลง**`
        )
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Large)
    )
    .addActionRowComponents(selectRow)
    .addActionRowComponents(buttonRow);
}

async function refreshPanel(state) {
  if (!state.panelMessage) return;

  try {
    await state.panelMessage.edit({
      components: [createPanel(state)]
    });
  } catch (error) {
    console.error('[PANEL UPDATE ERROR]', error.message);
  }
}

// =====================================
// STOP FFMPEG
// =====================================

function stopFFmpeg(state) {
  const process = state.ffmpeg;

  state.ffmpeg = null;

  if (process && process.exitCode === null && !process.killed) {
    process.kill('SIGKILL');
  }
}

// =====================================
// CLEANUP TEMP FILE
// =====================================

async function cleanupTempFile(state) {
  const dir = state.tempDir;

  state.tempDir = null;

  if (dir) {
    await fs.promises.rm(dir, {
      recursive: true,
      force: true
    }).catch(error => {
      console.error('[CLEANUP ERROR]', error.message);
    });
  }
}

// =====================================
// STOP MUSIC
// =====================================

function stopMusic(state) {
  // เปลี่ยน ID เพื่อป้องกัน event เก่ารบกวนเพลงใหม่
  state.playbackId++;
  state.isLoading = false;

  // ยกเลิกการดาวน์โหลดที่กำลังทำงาน
  if (state.downloadController) {
    state.downloadController.abort();
    state.downloadController = null;
  }

  stopPanelTicker(state);
  state.player.stop();

  stopFFmpeg(state);

  state.resource = null;
  state.currentSong = null;
  state.startedAt = null;
  state.durationMs = 0;

  cleanupTempFile(state);
  refreshPanel(state);
}

// =====================================
// VALIDATE URL
// =====================================

function isValidSongURL(url) {
  try {
    const parsed = new URL(url);

    const allowedHosts = [
      'files.catbox.moe',
      'pub-d1313a96a98b41459b66d4e08f54ae5c.r2.dev'
    ];

    return (
      parsed.protocol === 'https:' &&
      allowedHosts.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

// =====================================
// DOWNLOAD SONG
// =====================================

async function downloadSong(url, signal) {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'boombox-')
  );

  const tempFile = path.join(tempDir, 'song.mp3');

  try {
    console.log('[DOWNLOAD] Starting:', url);

    const response = await fetch(url, {
      signal,
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(
        `ดาวน์โหลดเพลงไม่สำเร็จ HTTP ${response.status}`
      );
    }

    if (!response.body) {
      throw new Error('ไม่พบข้อมูลเพลงจาก URL');
    }

    // ตรวจสอบ URL หลัง redirect ด้วย
    if (!isValidSongURL(response.url)) {
      throw new Error('URL ปลายทางดาวน์โหลดไม่ถูกต้อง');
    }

    const contentLength = Number(
      response.headers.get('content-length') || 0
    );

    if (contentLength > MAX_FILE_SIZE) {
      throw new Error('ไฟล์เพลงมีขนาดใหญ่เกิน 100 MB');
    }

    let downloadedBytes = 0;

    const sizeLimiter = new Transform({
      transform(chunk, encoding, callback) {
        downloadedBytes += chunk.length;

        if (downloadedBytes > MAX_FILE_SIZE) {
          callback(
            new Error('ไฟล์เพลงมีขนาดใหญ่เกิน 100 MB')
          );
          return;
        }

        callback(null, chunk);
      }
    });

    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimiter,
      fs.createWriteStream(tempFile),
      { signal }
    );

    const stat = await fs.promises.stat(tempFile);

    if (stat.size === 0) {
      throw new Error('ไฟล์เพลงว่างเปล่า');
    }

    console.log(
      '[DOWNLOAD] Completed:',
      stat.size,
      'bytes'
    );

    return {
      tempDir,
      tempFile
    };

  } catch (error) {
    await fs.promises.rm(tempDir, {
      recursive: true,
      force: true
    }).catch(() => {});

    throw error;
  }
}

// =====================================
// PLAY SONG
// DOWNLOAD FIRST VERSION
// =====================================

function attachVoiceConnectionLogging(connection, guildId) {
  connection.on('error', error => {
    console.error(`[${guildId}] VOICE ERROR:`, error);
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(
      `[${guildId}] VOICE STATE: ${oldState.status} -> ${newState.status}`
    );
  });

  connection.on('debug', message => {
    console.log(`[${guildId}] VOICE DEBUG: ${message}`);
  });
}

async function playSong(interaction, songId) {
  const song = songs[songId];

  if (!song) {
    throw new Error('ไม่พบเพลงใน songs.json');
  }

  if (!song.file || !isValidSongURL(song.file)) {
    throw new Error('URL เพลงไม่ถูกต้อง');
  }

  const voiceChannel = interaction.member.voice.channel;

  if (!voiceChannel) {
    throw new Error('กรุณาเข้าห้องเสียงก่อน');
  }

  const guildId = interaction.guild.id;
  const state = getGuildState(guildId);

  // หยุดเพลงเก่า
  stopMusic(state);
  state.isLoading = true;

  const playbackId = state.playbackId;

  let downloaded = null;

  try {
    // =================================
    // DOWNLOAD SONG
    // =================================

    console.log(`[${guildId}] Downloading song...`);

    const controller = new AbortController();

    state.downloadController = controller;

    try {
      downloaded = await downloadSong(
        song.file,
        controller.signal
      );

    } finally {
      if (state.downloadController === controller) {
        state.downloadController = null;
      }
    }

    // ตรวจสอบว่าเพลงยังเป็นรายการปัจจุบัน
    if (state.playbackId !== playbackId) {
      throw new Error('การเล่นเพลงถูกยกเลิก');
    }

    state.tempDir = downloaded.tempDir;

    console.log(`[${guildId}] Download completed`);

    // =================================
    // CONNECT VOICE
    // =================================

    if (
      !state.connection ||
      state.connection.state.status === VoiceConnectionStatus.Destroyed
    ) {
      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
        debug: true
      });

      attachVoiceConnectionLogging(state.connection, guildId);

    } else if (
      state.connection.joinConfig.channelId !== voiceChannel.id
    ) {
      state.connection.destroy();

      state.connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
        debug: true
      });

      attachVoiceConnectionLogging(state.connection, guildId);
    }

    await entersState(
      state.connection,
      VoiceConnectionStatus.Ready,
      20_000
    );

    if (state.playbackId !== playbackId) {
      throw new Error('การเล่นเพลงถูกยกเลิก');
    }

    state.connection.subscribe(state.player);

    // ตรวจความยาวเพลงจากไฟล์ที่ดาวน์โหลด
    state.durationMs = await getMediaDuration(downloaded.tempFile);

    if (state.playbackId !== playbackId) {
      throw new Error('การเล่นเพลงถูกยกเลิก');
    }

    console.log(
      `[${guildId}] TRACK DURATION: ${formatDuration(state.durationMs)}`
    );

    // =================================
    // START FFMPEG
    // =================================

    console.log(`[${guildId}] Starting FFmpeg...`);
    console.log(`[${guildId}] FILE: ${downloaded.tempFile}`);

    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostdin',

      '-i', downloaded.tempFile,

      // เลือกเฉพาะเสียง ไม่เอาภาพปก
      '-map', '0:a:0',
      '-vn',

      '-acodec', 'pcm_s16le',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',

      'pipe:1'

    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    state.ffmpeg = ffmpeg;
    state.currentSong = song.name;
    state.startedAt = Date.now();

    let ffmpegError = '';

    // =================================
    // FFMPEG STDERR
    // =================================

    ffmpeg.stderr.on('data', data => {
      const output = data.toString();

      ffmpegError += output;

      if (ffmpegError.length > 5000) {
        ffmpegError = ffmpegError.slice(-5000);
      }

      console.error(
        `[${guildId}] FFMPEG:`,
        output.trim()
      );
    });

    // =================================
    // FFMPEG PROCESS ERROR
    // =================================

    ffmpeg.on('error', error => {
      console.error(
        `[${guildId}] FFMPEG SPAWN ERROR:`,
        error
      );

      // ให้ close handler จัดการหยุดเพลงและ Auto Next
    });

    // =================================
    // FFMPEG PROCESS CLOSE
    // =================================

    ffmpeg.on('close', (code, signal) => {
      console.log(
        `[${guildId}] FFMPEG CLOSED`,
        { code, signal }
      );

      const failed = code !== 0 || signal !== null;

      if (failed) {
        console.error(
          `[${guildId}] FFMPEG DETAILS:`,
          ffmpegError
        );
      }

      if (state.ffmpeg === ffmpeg) {
        state.ffmpeg = null;

        if (failed && state.playbackId === playbackId) {
          state.player.stop();
        }
      }

      // ลบไฟล์เมื่อ FFmpeg อ่านไฟล์เสร็จ
      if (state.tempDir === downloaded.tempDir) {
        cleanupTempFile(state);
      }
    });

    // =================================
    // AUDIO RESOURCE
    // =================================

    ffmpeg.stdout.on('error', error => {
      console.error(
        `[${guildId}] FFMPEG STDOUT ERROR:`,
        error
      );
    });

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      metadata: {
        playbackId,
        songName: song.name
      }
    });

    resource.playStream.on('error', error => {
      console.error(
        `[${guildId}] RESOURCE STREAM ERROR:`,
        error
      );
    });

    state.resource = resource;

    // =================================
    // PLAY
    // =================================

    state.player.play(resource);
    refreshPanel(state);

    console.log(`[${guildId}] PLAYING: ${song.name}`);

    return song;

  } catch (error) {
    // ห้ามหยุดเพลงใหม่ หากคำขอเก่าถูกยกเลิก
    if (state.playbackId === playbackId) {
      stopMusic(state);
    }

    // ลบไฟล์ที่ดาวน์โหลดแล้ว หากยังไม่ได้เป็นไฟล์ของเพลงปัจจุบัน
    if (
      downloaded &&
      state.tempDir !== downloaded.tempDir
    ) {
      await fs.promises.rm(downloaded.tempDir, {
        recursive: true,
        force: true
      }).catch(() => {});
    }

    throw error;
  }
}

// =====================================
// REGISTER SLASH COMMAND
// =====================================

client.once('clientReady', async () => {
  console.log('===================================');
  console.log('📻 BOOMBOX V2 ONLINE');
  console.log(`🤖 BOT: ${client.user.tag}`);
  console.log('===================================');

  try {
    const command = new SlashCommandBuilder()
      .setName('boombox')
      .setDescription('เปิดแผงควบคุม Boombox');

    await client.application.commands.create(command);

    console.log('Slash Command Registered!');

  } catch (error) {
    console.error('COMMAND REGISTER ERROR:', error);
  }
});

// =====================================
// INTERACTION HANDLER
// =====================================

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return;

  try {

    // =================================
    // BOOMBOX COMMAND
    // =================================

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === 'boombox'
    ) {
      const voiceChannel = interaction.member.voice.channel;

      if (!voiceChannel) {
        return interaction.reply({
          content: '⚠️ กรุณาเข้าห้องเสียงก่อนเปิด Boombox',
          flags: MessageFlags.Ephemeral
        });
      }

      const state = getGuildState(interaction.guild.id);

      if (Object.keys(songs).length === 0) {
        return interaction.reply({
          content: '⚠️ ไม่มีเพลงในระบบ',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.reply({
        components: [createPanel(state)],
        flags: MessageFlags.IsComponentsV2
      });

      state.panelMessage = await interaction.fetchReply();

      return;

      }



    // =================================
    // SELECT SONG
    // =================================

    if (
      interaction.isStringSelectMenu() &&
      interaction.customId === 'v2_select_song'
    ) {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      try {
        const songId = interaction.values[0];
        const state = getGuildState(interaction.guild.id);
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
          return interaction.editReply({
            content: '⚠️ กรุณาเข้าห้องเสียงก่อนเลือกเพลง'
          });
        }

        if (!songs[songId]) {
          return interaction.editReply({
            content: '⚠️ ไม่พบเพลงที่เลือก กรุณาเปิดเมนูใหม่'
          });
        }

        state.playbackContext = {
          guild: interaction.guild,
          member: {
            voice: {
              channel: interaction.member.voice.channel
            }
          }
        };

        const isBusy =
          state.isLoading ||
          state.currentSong ||
          state.player.state.status === AudioPlayerStatus.Playing ||
          state.player.state.status === AudioPlayerStatus.Paused;

        if (isBusy) {
          state.queue.push(songId);
          await refreshPanel(state);

          return interaction.editReply({
            content: `📥 เพิ่ม **${songs[songId].name}** เข้าคิวแล้ว\n🎵 เพลงในคิว: ${state.queue.length} เพลง`
          });
        }

        const loadId = ++state.loadId;
        state.isLoading = true;

        try {
          const song = await playSong(state.playbackContext, songId);

          return interaction.editReply({
            content: `🎶 กำลังเปิดเพลง **${song.name}**`
          });
        } finally {
          if (state.loadId === loadId) {
            state.isLoading = false;
          }
        }

      } catch (error) {
        console.error('PLAY SONG ERROR:', error);

        return interaction.editReply({
          content: `⚠️ เล่นเพลงไม่สำเร็จ: ${error.message}`
        });
      }
    }

    // =================================
    // BUTTON CONTROL
    // =================================

    if (interaction.isButton()) {
      const state = guildPlayers.get(interaction.guild.id);

      if (!state) {
        return interaction.reply({
          content: '⚠️ ยังไม่มีเครื่องเล่นเพลง',
          flags: MessageFlags.Ephemeral
        });
      }

      // ตรวจสอบว่าผู้ใช้อยู่ห้องเดียวกับบอท
      const userChannel = interaction.member.voice.channelId;
      const botChannel = state.connection?.joinConfig.channelId;

      if (!userChannel || userChannel !== botChannel) {
        return interaction.reply({
          content: '⚠️ กรุณาอยู่ห้องเสียงเดียวกับบอท',
          flags: MessageFlags.Ephemeral
        });
      }

      // =================================
      // PAUSE / RESUME
      // =================================

      if (interaction.customId === 'v2_pause') {
        const status = state.player.state.status;

        if (status === AudioPlayerStatus.Playing) {
          state.player.pause();
          await refreshPanel(state);

          return interaction.reply({
            content: '⏸️ พักเพลงแล้ว',
            flags: MessageFlags.Ephemeral
          });
        }

        if (status === AudioPlayerStatus.Paused) {
          state.player.unpause();
          await refreshPanel(state);

          return interaction.reply({
            content: '▶️ เล่นเพลงต่อแล้ว',
            flags: MessageFlags.Ephemeral
          });
        }

        return interaction.reply({
          content: '⚠️ ไม่มีเพลงกำลังเล่น',
          flags: MessageFlags.Ephemeral
        });
      }

      // =================================
      // SKIP
      // =================================

      if (interaction.customId === 'v2_skip') {
        if (state.queue.length === 0) {
          return interaction.reply({
            content: '⚠️ ไม่มีเพลงถัดไปในคิว',
            flags: MessageFlags.Ephemeral
          });
        }

        await interaction.deferReply({
          flags: MessageFlags.Ephemeral
        });

        const nextSongId = state.queue.shift();
        const loadId = ++state.loadId;

        try {
          const song = await playSong(
            state.playbackContext,
            nextSongId
          );

          return interaction.editReply({
            content: `⏭️ ข้ามเพลงแล้ว กำลังเล่น **${song.name}**`
          });
        } catch (error) {
          console.error('[SKIP ERROR]:', error);

          if (state.loadId === loadId && state.queue.length > 0) {
            const expectedPlaybackId = state.playbackId;

            setImmediate(() => {
              startQueuedSong(
                state,
                interaction.guild.id,
                loadId,
                expectedPlaybackId
              );
            });
          }

          return interaction.editReply({
            content: `⚠️ เปิดเพลงถัดไปไม่สำเร็จ: ${error.message}`
          });
        } finally {
          if (state.loadId === loadId) {
            state.isLoading = false;
          }
        }
      }

      // =================================
      // STOP
      // =================================

      if (interaction.customId === 'v2_stop') {
        state.loadId++;
        state.isLoading = false;
        state.queue = [];
        stopMusic(state);

        if (state.connection) {
          state.connection.destroy();
          state.connection = null;
        }

        return interaction.reply({
          content: '⏹️ หยุดเพลงและออกจากห้องแล้ว',
          flags: MessageFlags.Ephemeral
        });
      }
    }

  } catch (error) {
    console.error('INTERACTION ERROR:', error);

    const response = {
      content: '⚠️ เกิดข้อผิดพลาดในระบบ Boombox'
    };

    if (interaction.deferred) {
      await interaction.editReply(response).catch(() => {});
    } else if (!interaction.replied) {
      await interaction.reply({
        ...response,
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
});

// =====================================
// HTTP SERVER
// =====================================

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('📻 BOOMBOX V2 IS ONLINE');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP Server listening on port ${PORT}`);
});

// =====================================
// SHUTDOWN
// =====================================

async function shutdown() {
  console.log('Shutting down...');

  for (const state of guildPlayers.values()) {
    stopMusic(state);

    if (state.connection) {
      state.connection.destroy();
      state.connection = null;
    }
  }

  server.close();

  client.destroy();

  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// =====================================
// LOGIN
// =====================================

client.login(TOKEN);
