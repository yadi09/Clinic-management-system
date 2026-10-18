// The patient portal's words, in English and Amharic. One switch, never both at once.
export type Lang = "en" | "am";

const en = {
  welcome: "Your treatment, in your pocket", cardno: "Card number", see: "See my treatment", findcard: "Your card number is printed on your patient card.",
  typeCard: "Please type your card number.", noCard: "We could not find that card number. Check it against your patient card.",
  slow: "Too many tries. Please wait a minute and try again.", offline: "We could not reach the clinic's page. Check your connection.", retry: "Try again", wait: "Please wait…",
  portal: "Patient portal", out: "Sign out", swipe: "← swipe to move between sections →",
  home: "Home", treat: "Treatment", pay: "Payments", teeth: "My teeth",
  hello: "Hello", homesub: "Here is where your treatment stands today.", next: "Next visit", visit: "visit", call: "Call the clinic",
  yourTreat: "Your treatment", inprog: "In progress", finished: "Finished", done: "done", visitsDone: "visits done", noTreat: "No treatment yet. Your clinic will add it here.",
  yourPay: "Your payments", paid: "Paid", toPay: "Still to pay", fromClinic: "From your clinic",
  summary: "Summary", unbilled: "Treatment done — bill not issued yet", unbilledHelp: "You will be told the amount before you pay.",
  receipts: "Receipts", noReceipts: "No receipts yet.", plan: "Payment plan", visits: "visits",
  chart2d: "2D chart", chart3d: "3D 🦷", inMouth: "In your mouth", planned: "Planned", doneRecently: "Done recently",
  tapTooth: "Tap a tooth", tapHelp: "to see what it has and what is planned.", tooth: "Tooth", healthy: "Healthy. Nothing recorded.",
};
const am: typeof en = {
  welcome: "ህክምናዎ፣ በኪስዎ ውስጥ", cardno: "የካርድ ቁጥር", see: "ህክምናዬን እይ", findcard: "የካርድ ቁጥርዎ በታካሚ ካርድዎ ላይ ተጽፏል።",
  typeCard: "እባክዎ የካርድ ቁጥርዎን ይጻፉ።", noCard: "ይህን የካርድ ቁጥር አላገኘነውም። በታካሚ ካርድዎ ላይ ካለው ጋር ያመሳስሉ።",
  slow: "ብዙ ሙከራ ተደርጓል። ትንሽ ቆይተው ይሞክሩ።", offline: "የክሊኒኩን ገጽ ማግኘት አልተቻለም። ግንኙነትዎን ያረጋግጡ።", retry: "እንደገና ይሞክሩ", wait: "እባክዎ ይጠብቁ…",
  portal: "የታካሚ ገጽ", out: "ውጣ", swipe: "← በክፍሎች መካከል ለመሄድ ያንሸራትቱ →",
  home: "መነሻ", treat: "ህክምና", pay: "ክፍያ", teeth: "ጥርሶቼ",
  hello: "ሰላም", homesub: "ህክምናዎ ዛሬ ያለበት ሁኔታ እነሆ።", next: "ቀጣይ ቀጠሮ", visit: "ጉብኝት", call: "ክሊኒኩን ደውል",
  yourTreat: "ህክምናዎ", inprog: "በሂደት ላይ", finished: "ተጠናቋል", done: "ተጠናቋል", visitsDone: "ጉብኝቶች ተጠናቀዋል", noTreat: "እስካሁን ህክምና የለም። ክሊኒክዎ እዚህ ያስገባል።",
  yourPay: "ክፍያዎችዎ", paid: "የከፈሉት", toPay: "የሚቀረው ክፍያ", fromClinic: "ከክሊኒክዎ",
  summary: "ማጠቃለያ", unbilled: "ህክምናው ተሠርቷል — ክፍያው ገና አልተጠየቀም", unbilledHelp: "ከመክፈልዎ በፊት መጠኑ ይነገርዎታል።",
  receipts: "ደረሰኞች", noReceipts: "እስካሁን ደረሰኝ የለም።", plan: "የክፍያ እቅድ", visits: "ጉብኝቶች",
  chart2d: "2D ሰንጠረዥ", chart3d: "3D 🦷", inMouth: "በአፍዎ ውስጥ ያለ", planned: "የታቀደ", doneRecently: "በቅርቡ የተሠራ",
  tapTooth: "ጥርስ ይንኩ", tapHelp: "ምን እንዳለው እና ምን እንደታቀደ ለማየት።", tooth: "ጥርስ", healthy: "ጤናማ። ምንም አልተመዘገበም።",
};
export const T: Record<Lang, typeof en> = { en, am };
