# VHS Tape for build-with-ai Demo
Output demo.gif

Set Margin 20
Set MarginFill "#6B50FF"
Set BorderRadius 10
Set WindowBar Colorful
Set Theme "TokyoNight"
Set FontSize 16
Set Width 1200
Set Height 700

# Require the CLI to be available
Require build-with-ai

# Command 1: init
Type "build-with-ai init"
Enter
Sleep 1.5s

# Prompt: Select Template (Arrow Down to SaaS MVP, then Enter)
Down 1
Sleep 500ms
Enter
Sleep 1s

# Prompt: Experience Level (Enter for Beginner)
Enter
Sleep 1s

# Prompt: Project Name
Type "demo-project"
Enter
Sleep 1s

# Prompt: Project Idea
Type "A sleek AI-powered terminal app."
Enter
Sleep 2.5s

# Command 2: next
Type "build-with-ai next"
Enter
Sleep 2s

# Prompt: Architectural decisions
Type "Next.js with Tailwind CSS"
Enter
Sleep 2.5s

# Command 3: done
Type "build-with-ai done"
Enter
Sleep 2s

# Command 4: export
Type "build-with-ai export"
Enter
Sleep 3s

# Show the README
Type "cat README.md"
Enter
Sleep 4s
