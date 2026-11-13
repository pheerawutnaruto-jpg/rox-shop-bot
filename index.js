const { Client, GatewayIntentBits, SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
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

// ฟังก์ชันสร้างหน้าตาแผง Boombox ถาวร
function createBoomboxPanel(statusText = '⏹️ พร้อมใช้งาน (เลือกเพลงด้านล่างเพื่อเริ่มเปิด)') {
    const embed = new EmbedBuilder()
        .setTitle('📻 Roblox Style Boombox — ตู้เพลงประจำห้อง')
        .setDescription('เข้าห้องเสียง (Voice Channel) แล้วเลือกเพลงจากเมนูด้านล่างได้เลยครับ!')
        .setColor('#1DB954')
        .addFields({ name: 'สถานะเครื่องเล่น', value: statusText })
        .setFooter({ text: 'กดเลือกเพลงใหม่ได้ตลอดเวลา • แผงควบคุมถาวร' });

    const options = Object.entries(songs).map(([id, info]) => ({
        label: info.name,
        description: `รหัสเพลง: ${id}`,
        value: id,
        emoji: '🎵'
    }));

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('perm_select_song')
        .setPlaceholder('🎧 กดเพื่อเลือกเพลงที่ต้องการเปิด...')
        .addOptions(options);

    const controlRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('perm_pause').setLabel('พัก / เล่นต่อ').setStyle(ButtonStyle.Secondary).setEmoji('⏯️'),
        new ButtonBuilder().setCustomId('perm_stop').setLabel('หยุดเพลง & ออกจากห้อง').setStyle(ButtonStyle.Danger).setEmoji('⏹️')
    );

    const menuRow = new ActionRowBuilder().addComponents(selectMenu);

    return { embeds: [embed], components: [menuRow, controlRow] };
}

client.once('ready', async () => {
    console.log(`📻 Boombox ถาวรพร้อมทำงานแล้วในชื่อ ${client.user.tag}!`);

    // ลงทะเบียนคำสั่ง /setup สำหรับแอดมินเอาไว้วางแผงถาวร
    const command = new SlashCommandBuilder()
        .setName('setup')
        .setDescription('วางแผงควบคุม Boombox แบบถาวรไว้ในห้องนี้ (เฉพาะแอดมิน)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

    await client.application.commands.create(command);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) return;

    // 1. แอดมินพิมพ์ /setup เพื่อตั้งแผง Boombox ถาวร
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
        const panel = createBoomboxPanel();
        await interaction.channel.send(panel);
        return interaction.reply({ content: '✅ ติดตั้งแผง Boombox ถาวรเรียบร้อย! (แนะนำให้ปักหมุดข้อความนี้ไว้ครับ)', ephemeral: true });
    }

    // 2. สมาชิกกดเลือกเพลงจากเมนูบนแผงถาวร
    if (interaction.isStringSelectMenu() && interaction.customId === 'perm_select_song') {
        const songId = interaction.values[0];
        const songData = songs[songId];
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            return interaction.reply({ content: '⚠️ คุณต้องเข้าห้องเสียง (Voice Channel) ก่อนถึงจะเปิดเพลงได้ครับ!', ephemeral: true });
        }

        currentConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        const filePath = path.join(__dirname, 'songs', songData.file);
        const resource = createAudioResource(filePath);

        player.play(resource);
        currentConnection.subscribe(player);

        // อัปเดตสถานะบนแผงเดิม (ไม่สร้างข้อความใหม่ให้รกแชท)
        const updatedPanel = createBoomboxPanel(`🎶 กำลังเล่น: **${songData.name}**\n👤 เปิดโดย: ${interaction.user}`);
        await interaction.update(updatedPanel);
    }

    // 3. สมาชิกกดปุ่มควบคุมบนแผงถาวร
    if (interaction.isButton()) {
        if (interaction.customId === 'perm_pause') {
            if (player.state.status === 'playing') {
                player.pause();
                await interaction.reply({ content: '⏸️ พักเพลงชั่วคราว', ephemeral: true });
            } else if (player.state.status === 'paused') {
                player.unpause();
                await interaction.reply({ content: '▶️ เล่นเพลงต่อแล้ว', ephemeral: true });
            } else {
                await interaction.reply({ content: '⚠️ ตอนนี้ยังไม่มีเพลงเล่นอยู่ครับ', ephemeral: true });
            }
        } else if (interaction.customId === 'perm_stop') {
            player.stop();
            if (currentConnection) {
                currentConnection.destroy();
                currentConnection = null;
            }
            // รีเซ็ตสถานะบนแผงกลับเป็นพร้อมใช้งาน (แต่แผงยังอยู่ครบ!)
            const resetPanel = createBoomboxPanel('⏹️ หยุดเล่นแล้ว (เลือกเพลงด้านล่างเพื่อเปิดใหม่)');
            await interaction.update(resetPanel);
        }
    }
});

// ระบบกันบอทหลับบน Render
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Permanent Boombox Panel is Alive!');
}).listen(process.env.PORT || 3000);

client.login(process.env.BOT_TOKEN);
