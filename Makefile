all: build push

default: build

build:
	docker build -t clickandmortar/ksnapshot:latest .

push:
	docker push clickandmortar/ksnapshot:latest
