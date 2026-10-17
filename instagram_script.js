// =========================================================================
// INSTAGRAM AI CHATBOT DIRECT SCRIPT (@yii_aimao & Bryan)
// Tempelkan kode ini di Console DevTools (F12) Instagram Edge Anda!
// =========================================================================

(function() {
    console.log("%c🚀 Instagram AI Bot Aktif di Tab Ini!", "color: #ff3366; font-size: 16px; font-weight: bold;");
    console.log("%c💑 Mode: Pasangan @bryanadelson (Chinese Native Girlfriend)", "color: #00cc88; font-size: 13px;");

    let lastReplied = "";
    let isProcessing = false;

    // Helper untuk mengetik teks secara alami
    function typeAndSend(text) {
        const textbox = document.querySelector("div[role='textbox'], div[contenteditable='true']");
        if (!textbox) {
            console.warn("Kolom chat belum terbuka. Klik salah satu obrolan terlebih dahulu!");
            return;
        }

        textbox.focus();
        // Masukkan teks ke textbox
        document.execCommand("insertText", false, text);

        setTimeout(() => {
            // Tekan tombol Enter untuk mengirim
            const enterEvt = new KeyboardEvent("keydown", {
                bubbles: true,
                cancelable: true,
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13
            });
            textbox.dispatchEvent(enterEvt);

            // Coba klik tombol kirim jika ada
            setTimeout(() => {
                const buttons = document.querySelectorAll("div[role='button'], button");
                for (const btn of buttons) {
                    if (btn.innerText.trim() === "Kirim" || btn.innerText.trim() === "Send") {
                        btn.click();
                        break;
                    }
                }
                console.log("%c✅ Balasan Berhasil Terkirim ke DM!", "color: #00cc88; font-weight: bold;");
            }, 300);
        }, 500);
    }

    // Loop pemantau chat setiap 3 detik
    const watcher = setInterval(async () => {
        if (isProcessing) return;

        // Deteksi lawan bicara dari header chat
        const headerTitle = document.querySelector("header h1, header span[dir='auto'], header a span");
        const partnerName = headerTitle ? headerTitle.innerText.trim() : "bryanadelson";

        // Ambil pesan-pesan yang ada di layar
        const bubbles = document.querySelectorAll("div[dir='auto']");
        if (bubbles.length === 0) return;

        // Ambil elemen teks terakhir
        const lastBubble = bubbles[bubbles.length - 1];
        const msgText = lastBubble.innerText.trim();

        if (!msgText || msgText.length === 0) return;

        // Abaikan teks sistem seperti "Seen", "Dibaca", waktu dll
        if (["Seen", "Dibaca", "Active now", "Aktif sekarang"].includes(msgText)) return;

        // Jika pesan baru dan belum pernah dibalas
        if (msgText !== lastReplied) {
            // Cek apakah ini pesan dari lawan bicara (bukan chat yang baru kita kirim)
            // Di Instagram, chat yang kita kirim biasanya berada di sebelah kanan (align-items: flex-end)
            const parentRow = lastBubble.closest("div[class*='x1n2onr6']");
            
            lastReplied = msgText;
            console.log(`%c📩 [DM DARI ${partnerName}]: "${msgText}"`, "color: #3399ff; font-weight: bold;");

            isProcessing = true;
            try {
                // Minta balasan dari server lokal Gemini AI
                const res = await fetch("http://localhost:3000/api/chat-ai", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: msgText, sender: partnerName })
                });

                const data = await res.json();
                if (data.reply) {
                    console.log(`%c💬 [BALASAN AI @yii_aimao]: "${data.reply}"`, "color: #ff3366;");
                    typeAndSend(data.reply);
                }
            } catch (err) {
                console.error("Gagal menghubungi server Gemini lokal:", err);
            } finally {
                setTimeout(() => { isProcessing = false; }, 4000);
            }
        }
    }, 3000);

    window.__ig_bot_watcher = watcher;
    console.log("%c💡 Bot sedang memantau obrolan. Setiap kali ada chat baru, AI akan membalas otomatis!", "color: #f39c12;");
})();
