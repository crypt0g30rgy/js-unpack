# Use minimal official Node.js 14 alpine image
FROM node:14-alpine

# Create app directory
WORKDIR /app

# Copy only the restore script
COPY restore-sourcemap.js .

# Make script executable
RUN chmod +x restore-sourcemap.js

# Default entrypoint to the script
ENTRYPOINT ["node", "restore.js"]