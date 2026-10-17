/**
 * The evaluation set for the code-language guess (src/core/code-language.ts).
 *
 * Every sample is invented for this file: snippets of the shape people paste,
 * a few lines long, and single lines where one line says enough. `NOT_CODE`
 * is what must stay without a language: prose, logs, stack traces, markdown
 * and the like.
 *
 * Keys are the names the guess answers (highlight.js keys; HTML is `xml`).
 */

export const SAMPLES: Record<string, { lines: string[]; one: string[] }> = {
  python: {
    lines: [
      'def mean(values):\n    if not values:\n        return 0\n    return sum(values) / len(values)',
      'import os\nfrom pathlib import Path\n\nfor name in os.listdir("."):\n    print(Path(name).suffix)',
      'class Point:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\n\n    def norm(self):\n        return (self.x ** 2 + self.y ** 2) ** 0.5',
      'with open("data.txt") as f:\n    lines = [l.strip() for l in f]\nprint(len(lines))',
      'try:\n    value = int(text)\nexcept ValueError:\n    value = None',
      '@app.route("/items")\ndef items():\n    return jsonify(store.all())',
      'counts = {}\nfor word in words:\n    counts[word] = counts.get(word, 0) + 1\nprint(sorted(counts.items(), key=lambda kv: -kv[1])[:10])',
      'async def fetch(session, url):\n    async with session.get(url) as response:\n        return await response.text()',
    ],
    one: ['def area(radius): return 3.14 * radius * radius', 'from collections import defaultdict', 'print(f"Total: {total:.2f}")'],
  },
  javascript: {
    lines: [
      'const total = (items) => {\n  let sum = 0\n  for (const item of items) sum += item.amount\n  return sum\n}\nconsole.log(total([]))',
      "document.querySelector('#save').addEventListener('click', () => {\n  form.submit()\n})",
      "const express = require('express')\nconst app = express()\napp.get('/', (req, res) => res.send('ok'))\napp.listen(3000)",
      'function debounce(fn, ms) {\n  let timer\n  return function (...args) {\n    clearTimeout(timer)\n    timer = setTimeout(() => fn.apply(this, args), ms)\n  }\n}',
      "import { readFile } from 'node:fs/promises'\n\nexport async function load(path) {\n  const text = await readFile(path, 'utf8')\n  return JSON.parse(text)\n}",
      'fetch("/api/items")\n  .then((r) => r.json())\n  .then((items) => {\n    list.innerHTML = items.map((i) => `<li>${i.name}</li>`).join("")\n  })',
    ],
    one: ["document.getElementById('menu').classList.toggle('open');", 'const doubled = values.map((v) => v * 2);', 'console.log("ready");'],
  },
  typescript: {
    lines: [
      'interface Item {\n  amount: number\n}\nexport const total = (items: Item[]): number =>\n  items.reduce((s, i) => s + i.amount, 0)',
      "type Shape = { kind: 'circle'; r: number } | { kind: 'square'; side: number }\n\nfunction area(s: Shape): number {\n  return s.kind === 'circle' ? Math.PI * s.r ** 2 : s.side ** 2\n}",
      'export class Cache<T> {\n  private store = new Map<string, T>()\n  get(key: string): T | undefined {\n    return this.store.get(key)\n  }\n}',
      "const config: Record<string, string> = {}\nexport default function setup(name: string, value: unknown): void {\n  config[name] = String(value)\n}",
    ],
    one: ['const count: number = items.length;', 'type Id = string | number', 'export interface User { name: string; email?: string }'],
  },
  bash: {
    lines: [
      'cd ~/projects/widget\nnpm install\nexport NODE_ENV=production\nif [ -f .env ]; then\n  source .env\nfi',
      '#!/usr/bin/env bash\nset -euo pipefail\nfor f in *.txt; do echo "$f"; done',
      'for f in *.log; do\n  gzip "$f"\ndone\nls -lh *.gz',
      'sudo apt-get update\nsudo apt-get install -y build-essential git curl',
      'mkdir -p build && cd build\ncmake ..\nmake -j"$(nproc)"',
      'if [ -z "$HOME" ]; then\n  echo "no home" >&2\n  exit 1\nfi',
      'git checkout -b feature\ngit add .\ngit commit -m "Add the widget"\ngit push origin feature',
    ],
    one: ['$ npm install --save-dev vitest', 'sudo apt-get install -y ffmpeg', 'tar -xzf archive.tar.gz -C /opt', 'grep -rn "TODO" src | wc -l'],
  },
  sql: {
    lines: [
      'SELECT name, COUNT(*) AS n\nFROM orders\nWHERE total > 10\nGROUP BY name;',
      'CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);',
      'UPDATE accounts\nSET balance = balance - 10\nWHERE id = 7;',
      'select o.id, c.name\nfrom orders o\njoin customers c on c.id = o.customer_id\nwhere o.total > 100\norder by o.created_at desc;',
      "INSERT INTO products (name, price)\nVALUES ('lamp', 19.99),\n       ('desk', 120.00);",
    ],
    one: ['SELECT name, email FROM users WHERE active = 1;', "INSERT INTO orders (id, total) VALUES (1, 9.99);", 'select * from logs where level = \'error\' limit 20;'],
  },
  java: {
    lines: [
      'public class Hello {\n    public static void main(String[] args) {\n        System.out.println("Hi");\n    }\n}',
      'import java.util.ArrayList;\nimport java.util.List;\n\nList<String> names = new ArrayList<>();\nnames.add("a");',
      '@Override\npublic String toString() {\n    return "Point(" + x + ", " + y + ")";\n}',
      'package com.example.app;\n\npublic interface Greeter {\n    String greet(String name);\n}',
      'private final Map<String, BigDecimal> totals = new HashMap<>();\n\npublic void add(String key, BigDecimal amount) {\n    totals.merge(key, amount, BigDecimal::add);\n}',
    ],
    one: ['System.out.println("total: " + total);', 'public static void main(String[] args) {', 'import java.util.concurrent.ConcurrentHashMap;'],
  },
  csharp: {
    lines: [
      'using System;\n\nclass Program\n{\n    static void Main(string[] args)\n    {\n        Console.WriteLine("hi");\n    }\n}',
      'public class Order\n{\n    public int Id { get; set; }\n    public decimal Total { get; set; }\n}',
      'var names = new List<string> { "a", "b" };\nforeach (var name in names)\n{\n    Console.WriteLine(name);\n}',
      'namespace Shop.Models;\n\npublic record Item(string Name, decimal Price);',
      'public async Task<IActionResult> Get(int id)\n{\n    var item = await _db.Items.FindAsync(id);\n    return item is null ? NotFound() : Ok(item);\n}',
    ],
    one: ['Console.WriteLine($"Total: {total}");', 'using System.Collections.Generic;', 'public string Name { get; set; }'],
  },
  go: {
    lines: [
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}',
      'func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {\n\tif r.Method != http.MethodGet {\n\t\thttp.Error(w, "no", http.StatusMethodNotAllowed)\n\t\treturn\n\t}\n}',
      'counts := make(map[string]int)\nfor _, w := range words {\n\tcounts[w]++\n}',
      'type Point struct {\n\tX, Y float64\n}\n\nfunc (p Point) Norm() float64 {\n\treturn math.Hypot(p.X, p.Y)\n}',
      'f, err := os.Open(path)\nif err != nil {\n\treturn err\n}\ndefer f.Close()',
    ],
    one: ['fmt.Println("hello")', 'func add(a, b int) int { return a + b }', 'if err != nil { return nil, err }'],
  },
  php: {
    lines: [
      '<?php\n$items = [1, 2, 3];\nforeach ($items as $item) {\n    echo $item;\n}',
      'public function show(int $id)\n{\n    $user = $this->repo->find($id);\n    return view("user", ["user" => $user]);\n}',
      'namespace App\\Http\\Controllers;\n\nuse App\\Models\\User;\n\nclass UserController extends Controller\n{\n}',
      '$total = 0;\nforeach ($cart as $line) {\n    $total += $line["price"] * $line["qty"];\n}\necho number_format($total, 2);',
    ],
    one: ['<?php echo "hello"; ?>', '$user = $repo->find($id);', 'echo $name . " is here";'],
  },
  powershell: {
    lines: [
      'Get-ChildItem -Path C:\\Logs -Filter *.log |\n    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |\n    Remove-Item',
      'param (\n    [string]$Name = "world"\n)\nWrite-Host "Hello $Name"',
      '$services = Get-Service | Where-Object Status -eq "Running"\nforeach ($s in $services) {\n    Write-Output $s.Name\n}',
      'Import-Module ActiveDirectory\nNew-Item -ItemType Directory -Path .\\out -Force\nSet-Location .\\out',
    ],
    one: ['Get-ChildItem -Recurse *.tmp | Remove-Item', 'Set-ExecutionPolicy RemoteSigned -Scope CurrentUser', 'Install-Module -Name Pester -Force'],
  },
  c: {
    lines: [
      '#include <stdio.h>\n\nint main(void) {\n    printf("hello\\n");\n    return 0;\n}',
      'int *copy(const int *src, size_t n) {\n    int *dst = malloc(n * sizeof *dst);\n    if (!dst) return NULL;\n    memcpy(dst, src, n * sizeof *dst);\n    return dst;\n}',
      'typedef struct node {\n    int value;\n    struct node *next;\n} node_t;',
      '#include <stdlib.h>\n#include <string.h>\n\nstatic char buffer[256];\n\nvoid reset(void) {\n    memset(buffer, 0, sizeof buffer);\n}',
      'for (int i = 0; i < n; i++) {\n    sum += a[i];\n}\nprintf("%d\\n", sum);',
      '#define MAX(a, b) ((a) > (b) ? (a) : (b))\n\nint clamp(int v, int lo, int hi) {\n    return MAX(lo, v < hi ? v : hi);\n}',
    ],
    one: ['#include <stdio.h>', 'printf("%d items\\n", count);', 'int *p = malloc(n * sizeof(int));'],
  },
  cpp: {
    lines: [
      '#include <iostream>\n\nint main() {\n    std::cout << "hi" << std::endl;\n    return 0;\n}',
      '#include <vector>\n#include <algorithm>\n\nstd::vector<int> v{3, 1, 2};\nstd::sort(v.begin(), v.end());',
      'class Shape {\npublic:\n    virtual ~Shape() = default;\n    virtual double area() const = 0;\n};',
      'template <typename T>\nT max_of(const std::vector<T>& xs) {\n    return *std::max_element(xs.begin(), xs.end());\n}',
      'auto p = std::make_unique<Widget>();\nfor (const auto& item : items) {\n    p->add(item);\n}',
    ],
    one: ['#include <iostream>', 'std::cout << "total: " << total << std::endl;', 'std::vector<int> values{1, 2, 3};'],
  },
  rust: {
    lines: [
      'fn main() {\n    let mut total = 0;\n    for i in 1..=10 {\n        total += i;\n    }\n    println!("{}", total);\n}',
      'use std::collections::HashMap;\n\nfn count(words: &[&str]) -> HashMap<&str, usize> {\n    let mut m = HashMap::new();\n    for w in words {\n        *m.entry(*w).or_insert(0) += 1;\n    }\n    m\n}',
      '#[derive(Debug, PartialEq)]\npub struct Point {\n    pub x: f64,\n    pub y: f64,\n}',
      'impl Point {\n    pub fn norm(&self) -> f64 {\n        (self.x * self.x + self.y * self.y).sqrt()\n    }\n}',
      'match value {\n    Some(v) if v > 0 => println!("positive"),\n    Some(_) => println!("other"),\n    None => {}\n}',
      'let file = File::open(path)?;\nlet reader = BufReader::new(file);\nfor line in reader.lines() {\n    let line = line?;\n}',
    ],
    one: ['fn main() { println!("hello"); }', 'let mut v: Vec<i32> = Vec::new();', 'use std::collections::HashMap;'],
  },
  ruby: {
    lines: [
      'class Greeter\n  def initialize(name)\n    @name = name\n  end\n\n  def greet\n    puts "Hello #{@name}"\n  end\nend',
      "require 'json'\n\ndata = JSON.parse(File.read('items.json'))\ndata.each do |item|\n  puts item['name']\nend",
      '[1, 2, 3].map { |n| n * 2 }.each { |n| puts n }',
      'module Billing\n  class Invoice < ApplicationRecord\n    belongs_to :customer\n    has_many :lines\n  end\nend',
      'def total(items)\n  items.sum { |i| i[:amount] }\nend\n\nputs total(items) unless items.empty?',
    ],
    one: ['puts "Hello, #{name}"', "require 'json'", 'attr_accessor :name, :email'],
  },
  kotlin: {
    lines: [
      'fun main() {\n    val names = listOf("a", "b", "c")\n    for (name in names) {\n        println(name)\n    }\n}',
      'data class User(val name: String, val age: Int)\n\nval users = mutableListOf<User>()\nusers.add(User("x", 3))',
      'class Repo(private val api: Api) {\n    suspend fun load(id: Int): Item? = api.get(id)\n}',
      'when (status) {\n    200 -> println("ok")\n    404 -> println("missing")\n    else -> println("other")\n}',
      'val total = items\n    .filter { it.price > 0 }\n    .sumOf { it.price }\nprintln("Total: $total")',
    ],
    one: ['fun greet(name: String) = println("Hello $name")', 'val names = listOf("a", "b")', 'data class Point(val x: Int, val y: Int)'],
  },
  swift: {
    lines: [
      'import SwiftUI\n\nstruct ContentView: View {\n    @State private var count = 0\n    var body: some View {\n        Text("Count: \\(count)")\n    }\n}',
      'func greet(name: String) -> String {\n    return "Hello, \\(name)"\n}\nprint(greet(name: "x"))',
      'guard let url = URL(string: text) else {\n    return\n}\nlet task = URLSession.shared.dataTask(with: url)',
      'var scores: [String: Int] = [:]\nfor (name, score) in pairs {\n    scores[name, default: 0] += score\n}',
      'if let user = currentUser {\n    print(user.name)\n} else {\n    print("nobody")\n}',
      'enum Direction {\n    case north, south, east, west\n}\nlet d: Direction = .north',
    ],
    one: ['import UIKit', 'guard let data = data else { return }', 'print("Hello, \\(name)")'],
  },
  xml: {
    lines: [
      '<!DOCTYPE html>\n<html>\n<head>\n  <title>Page</title>\n</head>\n<body>\n  <p>Hi</p>\n</body>\n</html>',
      '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <item key="a" value="1"/>\n  <item key="b" value="2"/>\n</config>',
      '<ul class="menu">\n  <li><a href="/">Home</a></li>\n  <li><a href="/about">About</a></li>\n</ul>',
      '<form action="/login" method="post">\n  <input type="text" name="user">\n  <button type="submit">Sign in</button>\n</form>',
      '<dependency>\n  <groupId>org.example</groupId>\n  <artifactId>widget</artifactId>\n  <version>1.0</version>\n</dependency>',
    ],
    one: ['<div class="note">Remember the milk</div>', '<?xml version="1.0" encoding="UTF-8"?>', '<a href="/about" class="link">About us</a>'],
  },
  css: {
    lines: [
      'body {\n  margin: 0;\n  font-family: sans-serif;\n}\n\n.button {\n  color: #fff;\n  background: #0366d6;\n}',
      '@media (max-width: 600px) {\n  .nav {\n    display: none;\n  }\n}',
      ':root {\n  --accent: #c33;\n}\na:hover {\n  color: var(--accent);\n  text-decoration: underline;\n}',
      '.grid {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 1rem;\n}',
      'h1, h2 {\n  line-height: 1.2;\n  margin-bottom: 0.5em;\n}',
    ],
    one: ['.btn { color: #fff; background: #0366d6; }', 'body { margin: 0; font-family: sans-serif; }', '@media (max-width: 600px) { .nav { display: none; } }'],
  },
  json: {
    lines: [
      '{\n  "name": "widget",\n  "version": "1.0.0"\n}',
      '[\n  { "id": 1, "done": true },\n  { "id": 2, "done": false }\n]',
      '{\n  "compilerOptions": {\n    "strict": true,\n    "target": "es2022"\n  }\n}',
    ],
    one: ['{"name": "widget", "count": 3}', '[{"id": 1}, {"id": 2}]'],
  },
  yaml: {
    lines: [
      'name: build\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test',
      'version: "3.8"\nservices:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"',
      'apiVersion: v1\nkind: Service\nmetadata:\n  name: web\nspec:\n  selector:\n    app: web',
      'server:\n  port: 8080\n  host: 0.0.0.0\nlogging:\n  level: debug',
    ],
    one: [],
  },
  dockerfile: {
    lines: [
      'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\nCMD ["node", "server.js"]',
      'FROM python:3.12-slim\nENV PYTHONUNBUFFERED=1\nRUN pip install --no-cache-dir flask\nEXPOSE 5000\nENTRYPOINT ["python", "app.py"]',
      'FROM golang:1.22 AS build\nWORKDIR /src\nCOPY . .\nRUN go build -o /out/app\n\nFROM gcr.io/distroless/base\nCOPY --from=build /out/app /app',
    ],
    one: ['FROM node:20-alpine', 'RUN apt-get update && apt-get install -y curl'],
  },
  makefile: {
    lines: [
      'CC = gcc\nCFLAGS = -Wall -O2\n\nall: app\n\napp: main.o util.o\n\t$(CC) $(CFLAGS) -o $@ $^\n\nclean:\n\trm -f *.o app',
      '.PHONY: test lint\n\ntest:\n\tnpm test\n\nlint:\n\tnpm run lint',
      'SRC := $(wildcard src/*.c)\nOBJ := $(SRC:.c=.o)\n\n%.o: %.c\n\t$(CC) -c $< -o $@',
    ],
    one: ['$(CC) $(CFLAGS) -o $@ $^', '.PHONY: all clean'],
  },
  lua: {
    lines: [
      'local M = {}\n\nfunction M.setup(opts)\n  opts = opts or {}\n  M.name = opts.name\nend\n\nreturn M',
      'for i, v in ipairs(items) do\n  if v > 0 then\n    print(i, v)\n  end\nend',
      'local function greet(name)\n  return "Hello " .. name\nend\nprint(greet("x"))',
      'local count = 0\nwhile count < 10 do\n  count = count + 1\nend',
    ],
    one: ['local t = setmetatable({}, { __index = base })', 'for k, v in pairs(config) do print(k, v) end'],
  },
  r: {
    lines: [
      'library(ggplot2)\n\ndf <- read.csv("data.csv")\nggplot(df, aes(x = age, y = income)) +\n  geom_point()',
      'scores <- c(90, 85, 77)\nmean(scores)\nsummary(scores)',
      'square <- function(x) {\n  x^2\n}\nsapply(1:5, square)',
      'df %>%\n  filter(year > 2000) %>%\n  group_by(region) %>%\n  summarise(total = sum(sales))',
    ],
    one: ['df <- read.csv("data.csv")', 'library(dplyr)', 'x <- c(1, 2, 3)'],
  },
  perl: {
    lines: [
      'use strict;\nuse warnings;\n\nmy @names = qw(a b c);\nforeach my $n (@names) {\n    print "$n\\n";\n}',
      'sub total {\n    my ($items) = @_;\n    my $sum = 0;\n    $sum += $_ for @$items;\n    return $sum;\n}',
      'while (my $line = <STDIN>) {\n    chomp $line;\n    next unless $line =~ /^\\d+$/;\n    print "$line\\n";\n}',
      'my %count;\n$count{$_}++ for split /\\s+/, $text;\nprint "$_: $count{$_}\\n" for sort keys %count;',
    ],
    one: ['my $name = shift;', 'use strict;', 'print "$_\\n" foreach @names;'],
  },
  scala: {
    lines: [
      'object Main extends App {\n  val xs = List(1, 2, 3)\n  println(xs.map(_ * 2))\n}',
      'case class Point(x: Int, y: Int)\n\ndef dist(a: Point, b: Point): Double =\n  math.hypot(a.x - b.x, a.y - b.y)',
      'sealed trait Shape\ncase class Circle(r: Double) extends Shape\ncase class Square(s: Double) extends Shape',
      'def area(s: Shape): Double = s match {\n  case Circle(r) => math.Pi * r * r\n  case Square(x) => x * x\n}',
      'import scala.concurrent.Future\nimport scala.util.Try\n\nval f: Future[Int] = Future(42)',
    ],
    one: ['object Main extends App {', 'case class Point(x: Int, y: Int)', 'val doubled = List(1, 2, 3).map(_ * 2)'],
  },
  haskell: {
    lines: [
      'main :: IO ()\nmain = do\n  name <- getLine\n  putStrLn ("Hello " ++ name)',
      'factorial :: Integer -> Integer\nfactorial 0 = 1\nfactorial n = n * factorial (n - 1)',
      'import qualified Data.Map as Map\n\ncount :: [String] -> Map.Map String Int\ncount = foldr (\\w -> Map.insertWith (+) w 1) Map.empty',
      'data Shape = Circle Double | Square Double\n  deriving (Show, Eq)\n\narea :: Shape -> Double\narea (Circle r) = pi * r * r\narea (Square s) = s * s',
      'module Main where\n\nimport Data.List (sortBy)\n\nmain :: IO ()\nmain = print (sortBy compare [3, 1, 2])',
    ],
    one: ['main = putStrLn "hello"', 'factorial :: Integer -> Integer', 'import qualified Data.Map as Map'],
  },
}

/** What must stay without a language, whether it arrives as one line or many. */
export const NOT_CODE: string[] = [
  'The quarterly review went well. The team shipped three features and fixed a number of defects that customers had reported.\n\nNext quarter the plan is to focus on performance (mostly start-up time), and on making the onboarding flow easier.',
  [
    '2024-03-01 12:00:01 INFO  Starting service on port 8080',
    '2024-03-01 12:00:02 WARN  Cache directory missing, creating /var/cache/app',
    '2024-03-01 12:00:05 ERROR Connection refused: db.internal:5432 (attempt 1 of 5)',
    '2024-03-01 12:00:10 INFO  Connected to database',
  ].join('\n'),
  'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nZeroDivisionError: division by zero',
  'Exception in thread "main" java.lang.NullPointerException\n\tat com.example.App.run(App.java:42)\n\tat com.example.App.main(App.java:10)',
  'TypeError: Cannot read properties of undefined (reading \'map\')\n    at render (app.js:12:20)\n    at main (app.js:40:3)',
  '# Project title\n\nSome intro text with **bold**.\n\n- item one\n- item two\n\n[link](https://example.com)',
  'Agenda (it may change):\n1. Budget review - 10 minutes\n2. Hiring plan for Q3\n3. Any other business',
  'name,amount\nwidget,10\ngadget,20',
  'From: Alice <alice@example.com>\nTo: Bob <bob@example.com>\nSubject: Lunch on Friday\n\nWho is in?',
  'Roses are red,\nviolets are blue,\nthe build is green\nand so are you.',
  '10.0.0.4 - - [01/Mar/2024:12:00:01 +0000] "GET /index.html HTTP/1.1" 200 512\n10.0.0.5 - - [01/Mar/2024:12:00:02 +0000] "GET /app.css HTTP/1.1" 304 0',
  'Shopping list:\n- milk\n- eggs\n- bread',
  'Q1  120  130\nQ2  140  150\nQ3  160  170',
  'Note: the office is closed on Monday.\nPlease send questions to the front desk.',
  'Thanks for the update.',
  'Meeting moved to 3pm.',
  'Total: $ 45.00',
  'Select a file from the list and press Open.',
  'From the desk of the editor',
  'Import duties apply to orders over 150 dollars.',
  'Let me know if you need anything else.',
  '$ 100 per month, billed yearly',
  'See https://example.com/docs/setup for the steps.',
  'C:\\Users\\guest\\Desktop\\report final.docx',
  'Error: file not found',
  'Use the main entrance on Elm Street.',
  'Step 1: open the box. Step 2: plug it in.',
  'Done!',
  '1. Preheat the oven',
  '(see page 12)',
  'version 2.3 notes',
]

/**
 * Written after the tells, and not tuned against: how the guess does on
 * snippets it has not seen. Same shape as SAMPLES.
 */
export const HELD_OUT: Record<string, { lines: string[]; one: string[] }> = {
  python: {
    lines: [
      'import json\n\ndef load(path):\n    with open(path) as fh:\n        return json.load(fh)',
      'numbers = [1, 2, 3, 4]\nsquares = [n * n for n in numbers if n % 2 == 0]\nprint(squares)',
    ],
    one: ['import numpy as np'],
  },
  javascript: {
    lines: [
      "const button = document.createElement('button')\nbutton.textContent = 'Go'\ndocument.body.appendChild(button)",
      'module.exports = function sum(a, b) {\n  return a + b\n}',
    ],
    one: ["const fs = require('fs')"],
  },
  typescript: {
    lines: [
      'export function clamp(value: number, min: number, max: number): number {\n  return Math.min(max, Math.max(min, value))\n}',
      'enum Move { Up, Down }\nlet m: Move = Move.Down\nconst names: string[] = []',
    ],
    one: ['let ready: boolean = false'],
  },
  bash: {
    lines: [
      'while read -r line; do\n  echo "got: $line"\ndone < input.txt',
      'docker build -t app .\ndocker run --rm -p 8080:80 app',
    ],
    one: ['$ git clone https://example.com/repo.git'],
  },
  sql: {
    lines: [
      'SELECT c.name, SUM(o.total) AS spent\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nGROUP BY c.name\nHAVING SUM(o.total) > 500;',
      'DELETE FROM sessions\nWHERE expires_at < NOW();',
    ],
    one: ['DELETE FROM carts WHERE created_at < now() - interval \'30 days\';'],
  },
  java: {
    lines: [
      'for (int i = 0; i < items.size(); i++) {\n    System.out.println(items.get(i));\n}',
      'public enum Level {\n    LOW, MEDIUM, HIGH;\n}\n\nprivate Level level = Level.LOW;',
    ],
    one: ['System.err.println("failed: " + e.getMessage());'],
  },
  csharp: {
    lines: [
      'var total = orders.Where(o => o.Paid).Sum(o => o.Amount);\nConsole.WriteLine(total);',
      'public interface IRepository<T>\n{\n    Task<T> GetAsync(int id);\n    Task SaveAsync(T item);\n}',
    ],
    one: ['using System.Linq;'],
  },
  go: {
    lines: [
      'package util\n\nfunc Reverse(s string) string {\n\tr := []rune(s)\n\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {\n\t\tr[i], r[j] = r[j], r[i]\n\t}\n\treturn string(r)\n}',
      'resp, err := http.Get(url)\nif err != nil {\n\tlog.Fatal(err)\n}\ndefer resp.Body.Close()',
    ],
    one: ['fmt.Printf("%d items\\n", len(items))'],
  },
  php: {
    lines: [
      '<?php\nfunction greet(string $name): string {\n    return "Hello, " . $name;\n}',
      '$rows = $pdo->query("SELECT * FROM users")->fetchAll();\nforeach ($rows as $row) {\n    echo $row["name"];\n}',
    ],
    one: ['$this->load->view("home");'],
  },
  powershell: {
    lines: [
      '$path = "C:\\temp\\report.csv"\nImport-Csv $path | Where-Object { $_.Status -eq "Open" } | Export-Csv open.csv',
      'foreach ($file in Get-ChildItem -Filter *.log) {\n    Write-Host $file.Name\n}',
    ],
    one: ['Get-Process | Sort-Object CPU -Descending | Select-Object -First 5'],
  },
  c: {
    lines: [
      'static int compare(const void *a, const void *b) {\n    return *(const int *)a - *(const int *)b;\n}\n\nqsort(values, n, sizeof(int), compare);',
      'FILE *fp = fopen("out.txt", "w");\nif (fp == NULL) {\n    perror("fopen");\n    return 1;\n}\nfprintf(fp, "%s\\n", line);\nfclose(fp);',
    ],
    one: ['#include <string.h>'],
  },
  cpp: {
    lines: [
      'std::map<std::string, int> ages;\nages["x"] = 3;\nfor (auto& [name, age] : ages) {\n    std::cout << name << age;\n}',
      'namespace geo {\nclass Circle {\npublic:\n    explicit Circle(double r) : r_(r) {}\nprivate:\n    double r_;\n};\n}',
    ],
    one: ['std::string name = "widget";'],
  },
  rust: {
    lines: [
      'pub enum Shape {\n    Circle(f64),\n    Square(f64),\n}\n\nimpl Shape {\n    pub fn area(&self) -> f64 {\n        match self {\n            Shape::Circle(r) => 3.14 * r * r,\n            Shape::Square(s) => s * s,\n        }\n    }\n}',
      'let names: Vec<String> = items.iter().map(|i| i.name.clone()).collect();\nprintln!("{:?}", names);',
    ],
    one: ['let v = vec![1, 2, 3];'],
  },
  ruby: {
    lines: [
      'def fizzbuzz(n)\n  (1..n).each do |i|\n    if i % 15 == 0\n      puts "FizzBuzz"\n    elsif i % 3 == 0\n      puts "Fizz"\n    else\n      puts i\n    end\n  end\nend',
      'hash = { name: "x", age: 3 }\nhash.each_pair { |k, v| puts "#{k}=#{v}" }',
    ],
    one: ['puts [1, 2, 3].sum'],
  },
  kotlin: {
    lines: [
      'fun isEven(n: Int): Boolean = n % 2 == 0\n\nval evens = (1..10).filter { isEven(it) }\nprintln(evens)',
      'class Counter {\n    private var count = 0\n    fun increment() {\n        count++\n    }\n}',
    ],
    one: ['val map = mutableMapOf<String, MutableList<Int>>()'],
  },
  swift: {
    lines: [
      'struct User: Codable {\n    let name: String\n    let age: Int\n}\n\nlet user = try JSONDecoder().decode(User.self, from: data)',
      'func fetch() async throws -> [Item] {\n    let (data, _) = try await URLSession.shared.data(from: url)\n    return try JSONDecoder().decode([Item].self, from: data)\n}',
    ],
    one: ['import Foundation'],
  },
  xml: {
    lines: [
      '<table>\n  <tr><th>Name</th><th>Qty</th></tr>\n  <tr><td>Lamp</td><td>2</td></tr>\n</table>',
      '<svg width="100" height="100">\n  <circle cx="50" cy="50" r="40" fill="red"/>\n</svg>',
    ],
    one: ['<img src="logo.png" alt="Logo"/>'],
  },
  css: {
    lines: [
      '.card {\n  border: 1px solid #ddd;\n  border-radius: 4px;\n  padding: 16px;\n}\n.card:hover {\n  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);\n}',
      '@keyframes spin {\n  from { transform: rotate(0deg); }\n  to { transform: rotate(360deg); }\n}',
    ],
    one: ['#header { position: sticky; top: 0; }'],
  },
  json: {
    lines: ['{\n  "scripts": {\n    "test": "vitest run"\n  },\n  "private": true\n}', '[\n  "red",\n  "green"\n]'],
    one: ['{"ok": true}'],
  },
  yaml: {
    lines: [
      'en:\n  greeting: Hello\n  farewell: Goodbye\nfr:\n  greeting: Bonjour',
      '- name: install packages\n  apt:\n    name: nginx\n    state: present',
    ],
    one: [],
  },
  dockerfile: {
    lines: ['FROM alpine:3.19\nRUN apk add --no-cache curl\nUSER nobody\nCMD ["curl", "--version"]', 'ARG VERSION=1\nFROM nginx:1.25\nCOPY site/ /usr/share/nginx/html/'],
    one: ['FROM ubuntu:22.04'],
  },
  makefile: {
    lines: ['build:\n\tgo build -o bin/app ./cmd/app\n\nrun: build\n\t./bin/app', 'install: all\n\tinstall -m 755 app $(DESTDIR)/usr/bin/app'],
    one: ['$(MAKE) -C src all'],
  },
  lua: {
    lines: [
      'local Stack = {}\nStack.__index = Stack\n\nfunction Stack.new()\n  return setmetatable({ items = {} }, Stack)\nend',
      'if x ~= nil then\n  print("set")\nelse\n  print("unset")\nend',
    ],
    one: ['local json = require("json")'],
  },
  r: {
    lines: [
      'model <- lm(mpg ~ wt, data = mtcars)\nsummary(model)\nplot(model)',
      'for (i in 1:10) {\n  if (i %% 2 == 0) print(i)\n}\nvals <- seq(1, 10, by = 2)',
    ],
    one: ['data <- read.table("input.txt", header = TRUE)'],
  },
  perl: {
    lines: [
      'open(my $fh, "<", $file) or die "Cannot open $file: $!";\nwhile (my $row = <$fh>) {\n    print $row if $row =~ /error/i;\n}\nclose($fh);',
      'my %ages = (ann => 30, bob => 25);\nfor my $name (sort keys %ages) {\n    printf "%s is %d\\n", $name, $ages{$name};\n}',
    ],
    one: ['my @sorted = sort { $a <=> $b } @numbers;'],
  },
  scala: {
    lines: [
      'val words = Seq("a", "bb", "ccc")\nval lengths = words.map(_.length)\nprintln(lengths.sum)',
      'trait Animal {\n  def speak(): String\n}\nclass Dog extends Animal {\n  def speak(): String = "Woof"\n}',
    ],
    one: ['val xs: List[Int] = List(1, 2, 3)'],
  },
  haskell: {
    lines: [
      'sumSquares :: [Int] -> Int\nsumSquares xs = sum (map (^2) xs)',
      'quicksort [] = []\nquicksort (p:xs) = quicksort smaller ++ [p] ++ quicksort larger\n  where\n    smaller = filter (< p) xs\n    larger = filter (>= p) xs',
    ],
    one: ['import Data.Char (toUpper)'],
  },
}
