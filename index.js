const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource } = require('@discordjs/voice');
const path = require('path');
const songs = require('./songs.json');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const player = createAudioPlayer();
let currentConnection = null;

client.once('ready', async () => {
    console.log(`📻 Boombox Spotify Style พร้อมทำงานแล้วในชื่อ ${client.user.tag}!`);

    // ลงทะเบียนคำสั่ง Slash Command (/boombox) อัตโนมัติเมื่อบอทเปิด
    const command = new SlashCommandBuilder()
        .setName('boombox')
        .setDescription('หยิบ Boombox ออกมาวางเพื่อเปิดเพลงเลือกจากเมนู!');

    await client.application.commands.create(command);
});

// จัดการเมื่อมีคนใช้คำสั่ง /boombox หรือกดปุ่ม/เมนู
client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) return;

    // 1. เมื่อพิมพ์ /boombox
    if (interaction.isChatInputCommand() && interaction.commandName === 'boombox') {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
            return interaction.reply({ content: '⚠️ คุณต้องเข้าห้องเสียง (Voice Channel) ก่อนหยิบ Boombox ออกมาครับ!', ephemeral: true });
        }

        // สร้าง Embed หน้าตาเหมือนเครื่องเล่นเพลง
        const embed = new EmbedBuilder()
            .setTitle('📻 Roblox Style Boombox')
            .setDescription('เลือกเพลงจากเมนูด้านล่าง หรือกดควบคุมเครื่องเล่นได้เลยครับเหมือน Spotify!')
            .setColor('#1DB954') // สีเขียวสไตล์ Spotify
            .addFields({ name: 'สถานะ', value: '⏹️ พักการใช้งาน (เลือกเพลงเพื่อเริ่มเล่น)' });

        // สร้าง Dropdown Menu เลือกเพลงจาก songs.json
        const options = Object.entries(songs).map(([id, info]) => ({
            label: info.name,
            description: `รหัสเพลง: ${id}`,
            value: id,
            emoji: '🎵'
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('select_song')
            .setPlaceholder('🎧 เลือกเพลงจาก Boombox...')
            .addOptions(options);

        // สร้างปุ่มควบคุม (Pause / Stop)
        const controlRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_pause').setLabel('Pause / Resume').setStyle(ButtonStyle.Secondary).setEmoji('⏯️'),
            new ButtonBuilder().setCustomId('btn_stop').setLabel('เก็บ Boombox').setStyle(ButtonStyle.Danger).setEmoji('⏹️')
        );

        const row1 = new ActionRowBuilder().addComponents(selectMenu);

        await interaction.reply({ embeds: [embed], components: [row1, controlRow] });
    }

    // 2. เมื่อมีคนเลือกเพลงจาก Dropdown Menu
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_song') {
        const songId = interaction.values[0];
        const songData = songs[songId];
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: '⚠️ คุณต้องอยู่ในห้องเสียงเดียวกันถึงจะเปลี่ยนเพลงได้!', ephemeral: true });
        }

        // เชื่อมต่อห้องเสียง
        currentConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        const filePath = path.join(__dirname, 'songs', songData.file);
        const resource = createAudioResource(filePath);

        player.play(resource);
        currentConnection.subscribe(player);

        await interaction.update({
            content: `🎶 กำลังเปิดเพลง: **${songData.name}** (เลือกโดย ${interaction.user})`,
            components: interaction.message.components // คงปุ่มเดิมไว้
        });
    }

    // 3. เมื่อกดปุ่มควบคุม (Pause หรือ Stop)
    if (interaction.isButton()) {
        if (interaction.customId === 'btn_pause') {
            if (player.state.status === 'playing') {
                player.pause();
                await interaction.reply({ content: '⏸️ พักเพลงชั่วคราว', ephemeral: true });
            } else if (player.state.status === 'paused') {
                player.unpause();
                await interaction.reply({ content: '▶️ เล่นเพลงต่อ', ephemeral: true });
            }
        } else if (interaction.customId === 'btn_stop') {
            player.stop();
            if (currentConnection) {
                currentConnection.destroy();
                currentConnection = null;
            }
            await interaction.update({ content: '⏹️ ปิดและเก็บ Boombox เรียบร้อยครับ', components: [] });
        }
    }
});

// ระบบกันบอทหลับบน Render
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Boombox Spotify Style is Alive!');
}).listen(process.env.PORT || 3000);

client.login(process.env.BOT_TOKEN);
